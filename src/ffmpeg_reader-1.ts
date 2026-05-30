import {ChildProcessWithoutNullStreams, spawn} from 'child_process';
import {existsSync, statSync} from 'fs';
import { onData, onEnd } from './types';
import {Binding} from "./binding";
import {BufferOptimized} from "./buffer_optimized";
import {getBuiltCommands, LogLevel} from "./utils";

type BuildFFmpegParams = (seekSeconds: number) => Array<string>;

export class FFmpegReader {
    private fifo_reader?: ChildProcessWithoutNullStreams;
    private total_size: number = 0;
    private bytes_read: BufferOptimized;
    private MAX_READ_BUFFER: number = 65536 * 4;
    private MAX_SIZE_BUFFERED: number = 5 * this.MAX_READ_BUFFER;
    private paused: boolean = true;
    private stopped: boolean = false;
    private readonly additional_parameters: string = '';
    private almostFinished: boolean = false;
    public haveEnd: boolean = true;
    private isLiveSharing: boolean = false;
    private buildParams?: BuildFFmpegParams;
    private sourcePath: string = '';
    private sourceIsLocalFile: boolean = false;
    private sourceLastSize: number = 0;
    private sourceHasGrown: boolean = false;
    private expectedDurationMs: number = 0;
    private outputBytesPerSecond: number = 0;
    private waitingForGrowth: boolean = false;
    private readonly growthCheckMs: number = 500;
    private readonly growthTimeoutMs: number = Number(process.env.PYTGCALLS_GROWING_TIMEOUT_MS || 30000);
    private processing: boolean = false;
    onData?: onData;
    onEnd?: onEnd;

    constructor(additional_parameters: string) {
        this.bytes_read = new BufferOptimized(0);
        this.additional_parameters = additional_parameters;
    }

    private normalizePath(path: string){
        return path
            .replace('fifo://', '')
            .replace('device://', '')
            .replace('screen://', '')
            .replace('image:', '');
    }

    private setupSource(path: string){
        this.sourcePath = this.normalizePath(path);
        this.sourceIsLocalFile = false;
        this.sourceLastSize = 0;
        this.sourceHasGrown = false;
        if(
            this.sourcePath &&
            !path.startsWith('device://') &&
            !path.startsWith('screen://') &&
            !path.includes('image:') &&
            !/^https?:\/\//i.test(this.sourcePath) &&
            existsSync(this.sourcePath)
        ){
            try {
                const stat = statSync(this.sourcePath);
                this.sourceIsLocalFile = stat.isFile();
                this.sourceLastSize = stat.size;
            } catch (e) {
                this.sourceIsLocalFile = false;
            }
        }
    }

    private sourceSize(){
        if(!this.sourceIsLocalFile){
            return 0;
        }
        try {
            return statSync(this.sourcePath).size;
        } catch (e) {
            return 0;
        }
    }

    private observeSourceGrowth(){
        if(!this.sourceIsLocalFile){
            return;
        }
        const currentSize = this.sourceSize();
        if(currentSize > this.sourceLastSize){
            this.sourceHasGrown = true;
            this.sourceLastSize = currentSize;
        }
    }

    private localFileInputParams(seekSeconds: number){
        const params: Array<string> = [];
        // For normal local files this is harmless, and for files that are still
        // being downloaded it prevents ffmpeg from racing to the temporary EOF.
        if(this.sourceIsLocalFile){
            params.push('-re');
        }
        if(seekSeconds > 0){
            params.push('-ss', seekSeconds.toFixed(3));
        }
        return params;
    }

    private decodedMs(){
        if(this.outputBytesPerSecond <= 0){
            return 0;
        }
        return (this.total_size / this.outputBytesPerSecond) * 1000;
    }

    private shouldKeepGrowingOpen(){
        if(!this.sourceIsLocalFile || !this.haveEnd){
            return false;
        }
        this.observeSourceGrowth();
        const decodedMs = this.decodedMs();
        const durationSaysEarlyEOF = this.expectedDurationMs > 0 &&
            decodedMs > 0 &&
            decodedMs + 2500 < this.expectedDurationMs;
        return this.sourceHasGrown || durationSaysEarlyEOF;
    }

    public convert_audio(path: string, bitrate: string){
        let cmds = getBuiltCommands(this.additional_parameters);
        this.isLiveSharing = path.startsWith('device://');
        this.setupSource(path);
        this.outputBytesPerSecond = Number(bitrate) * 2;
        this.buildParams = (seekSeconds: number) => cmds.audio.before.concat(
            this.localFileInputParams(seekSeconds),
        ).concat([
            '-i',
            this.normalizePath(path),
        ]).concat(cmds.audio.middle).concat([
            '-vn',
            '-f',
            's16le',
            '-ac',
            '1',
            '-ar',
            bitrate,
            'pipe:1',
        ]).concat(cmds.audio.after);
        this.start_conversion(0);
    }

    public convert_video(path: string, width: string, height: string, framerate: string){
       let cmds = getBuiltCommands(this.additional_parameters);
       if(path.includes('image:')){
           cmds.video.before = cmds.video.before.concat([
               '-loop',
               '1',
               '-framerate',
               '1',
           ]);
           this.haveEnd = false;
       }
       this.isLiveSharing = path.startsWith('screen://');
       this.setupSource(path);
       this.outputBytesPerSecond = 1.5 * Number(width) * Number(height) * Number(framerate);
       this.buildParams = (seekSeconds: number) => cmds.video.before.concat(
           this.localFileInputParams(seekSeconds),
       ).concat([
           '-i',
           this.normalizePath(path),
       ]).concat(cmds.video.middle).concat([
           '-an',
           '-f',
           'rawvideo',
           '-pix_fmt',
           'yuv420p',
           '-r',
           framerate,
           '-vf',
           'scale=' + width + ':' + height,
           'pipe:1',
       ]).concat(cmds.video.after);
       this.start_conversion(0);
    }

    private start_conversion(seekSeconds: number) {
        if(this.stopped || this.buildParams === undefined){
            return;
        }
        let params = this.buildParams(seekSeconds).filter(e => e);
        Binding.log('RUNNING_FFMPEG_COMMAND -> ffmpeg ' + params.join(' '), LogLevel.INFO);
        this.almostFinished = false;
        this.waitingForGrowth = false;
        this.fifo_reader = spawn('ffmpeg', params);
        this.fifo_reader.stdout.on('data', this.dataListener);
        this.fifo_reader.stderr.on('data', async (chunk: any) => {
            const message = chunk.toString();
            this.parseExpectedDuration(message);
            if (message.includes('] Opening')){
                Binding.log('OPENING_M3U8_SOURCE -> ' + (new Date().getTime()), LogLevel.DEBUG);
            } else if (message.includes('] Unable')) {
                let list_err = message.split('\n');
                for(let i = 0; i < list_err.length; i++){
                    if(list_err[i].includes('] Unable')){
                        Binding.log(list_err[i], LogLevel.ERROR);
                        break;
                    }
                }
            }
        });
        this.fifo_reader.on('close', this.endListener);
        if(!this.processing){
            this.processing = true;
            this.processBytes();
        }
    }

    private parseExpectedDuration(message: string){
        if(this.expectedDurationMs > 0){
            return;
        }
        const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message);
        if(duration !== null){
            const hours = Number(duration[1]);
            const minutes = Number(duration[2]);
            const seconds = Number(duration[3]);
            this.expectedDurationMs = ((hours * 3600) + (minutes * 60) + seconds) * 1000;
        }
    }

    private dataListener = (async (chunk: any) => {
        this.total_size += chunk.length;
        this.bytes_read.push(chunk);
        this.observeSourceGrowth();
        if(this.bytes_read.length >= this.MAX_SIZE_BUFFERED && !this.isLiveSharing){
            this.fifo_reader?.stdout.pause();
        }
    });

    private endListener = (async () => {
        if(this.stopped){
            this.processing = false;
            return;
        }
        if(this.shouldKeepGrowingOpen()){
            this.waitForGrowingInput();
            return;
        }
        this.almostFinished = true;
    });

    private waitForGrowingInput(){
        if(this.waitingForGrowth){
            return;
        }
        this.waitingForGrowth = true;
        const startedAt = new Date().getTime();
        let lastSize = this.sourceSize();
        const check = () => {
            if(this.stopped){
                return;
            }
            const currentSize = this.sourceSize();
            if(currentSize > lastSize){
                this.sourceHasGrown = true;
                this.sourceLastSize = currentSize;
                const seekSeconds = Math.max(0, this.decodedMs() / 1000);
                Binding.log(
                    'GROWING_FILE_CONTINUE -> ' + this.sourcePath +
                    ' -> seek=' + seekSeconds.toFixed(3),
                    LogLevel.INFO,
                );
                this.start_conversion(seekSeconds);
                return;
            }
            lastSize = currentSize;
            if(new Date().getTime() - startedAt >= this.growthTimeoutMs){
                Binding.log(
                    'GROWING_FILE_TIMEOUT -> ' + this.sourcePath +
                    ' -> decoded_ms=' + Math.round(this.decodedMs()) +
                    ' -> expected_ms=' + Math.round(this.expectedDurationMs),
                    LogLevel.WARNING,
                );
                this.almostFinished = true;
                this.waitingForGrowth = false;
                return;
            }
            setTimeout(check, this.growthCheckMs);
        };
        setTimeout(check, this.growthCheckMs);
    }

    private processBytes(){
        const oldTime = new Date().getTime();
        if(this.stopped){
            this.processing = false;
            return;
        }
        if(!this.paused){
            if(this.bytes_read.length > 0){
                if(this.bytes_read.length < this.MAX_SIZE_BUFFERED && !this.isLiveSharing){
                    this.fifo_reader?.stdout.resume();
                }
                this.bytes_read.byteLength = this.bytes_read.length < this.MAX_READ_BUFFER ? this.bytes_read.length:this.MAX_READ_BUFFER;
                if(this.onData != undefined){
                    const buffer = this.bytes_read.readBytes();
                    this.onData(buffer);
                }
            }else if(this.almostFinished){
                if(this.onEnd != undefined){
                    this.onEnd();
                }
                this.fifo_reader?.kill()
                this.processing = false;
                return;
            }
        }
        const toSubtract = new Date().getTime() - oldTime;
        setTimeout(
            async () => this.processBytes(),
            Math.max(0, 5 - toSubtract),
        );
    }
    public pause(){
        this.paused = true;
    }
    public resume(){
        this.paused = false;
    }
    public fileSize(){
        return this.total_size;
    }
    public stop(){
        this.fifo_reader?.stdout.removeListener('data', this.dataListener);
        this.fifo_reader?.removeListener('close', this.endListener);
        this.stopped = true;
        this.processing = false;
        this.fifo_reader?.stdout.pause();
        this.fifo_reader?.kill('SIGKILL');
    }
}
