import asyncio
import json
import subprocess
from json import JSONDecodeError
from typing import Dict
from typing import List
from typing import Optional

from .exceptions import FFmpegNotInstalled
from .exceptions import InvalidVideoProportion
from .exceptions import NoAudioSourceFound
from .exceptions import NoVideoSourceFound
from .types.input_stream.video_tools import check_support


class FFprobe:
    @staticmethod
    def ffmpeg_headers(
        headers: Optional[Dict[str, str]] = None,
    ):
        ffmpeg_params: List[str] = []
        if headers is not None:
            ffmpeg_params.append('-headers')
            built_header = ''
            for i in headers:
                built_header += f'{i}: {headers[i]}\r\n'
            ffmpeg_params.append(built_header)
        return ':_cmd_:'.join(
            ffmpeg_params,
        )

    @staticmethod
    async def _read_streams(
        path: str,
        ffmpeg_params: List[str],
    ):
        ffprobe = await asyncio.create_subprocess_exec(
            'ffprobe',
            '-v',
            'error',
            '-analyzeduration',
            '100M',
            '-probesize',
            '100M',
            '-show_entries',
            'stream=width,height,codec_type,codec_name',
            '-of',
            'json',
            *tuple(ffmpeg_params),
            path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, _ = await asyncio.wait_for(
                ffprobe.communicate(),
                timeout=30,
            )
            result = json.loads(stdout.decode('utf-8')) or {}
            return result.get('streams', [])
        except (subprocess.TimeoutExpired, JSONDecodeError):
            try:
                ffprobe.kill()
            except ProcessLookupError:
                pass
            return []

    @staticmethod
    async def _has_decodable_audio(
        path: str,
        ffmpeg_params: List[str],
    ):
        """Fallback for WebM/fragmented files where ffprobe misses audio.

        Some growing/fragmented WebM files do not report all streams with the
        short default probe, but ffmpeg still shows/decodes the audio stream.
        """
        ffmpeg = await asyncio.create_subprocess_exec(
            'ffmpeg',
            '-hide_banner',
            '-v',
            'info',
            '-analyzeduration',
            '100M',
            '-probesize',
            '100M',
            *tuple(ffmpeg_params),
            '-i',
            path,
            '-map',
            '0:a:0',
            '-t',
            '1',
            '-f',
            'null',
            '-',
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            _, stderr = await asyncio.wait_for(
                ffmpeg.communicate(),
                timeout=30,
            )
            message = stderr.decode('utf-8', errors='ignore')
            if 'Audio:' in message:
                return True
            no_audio_errors = (
                'Stream map \'0:a:0\' matches no streams',
                'matches no streams',
                'Output file #0 does not contain any stream',
            )
            return ffmpeg.returncode == 0 and not any(
                err in message for err in no_audio_errors
            )
        except subprocess.TimeoutExpired:
            try:
                ffmpeg.kill()
            except ProcessLookupError:
                pass
            return False

    @staticmethod
    async def check_file(
        path: str,
        needed_audio=False,
        needed_video=False,
        needed_image=False,
        headers: Optional[Dict[str, str]] = None,
    ):
        ffmpeg_params: List[str] = []
        have_header = False
        if headers is not None and \
                check_support(path):
            ffmpeg_params.append('-headers')
            built_header = ''
            have_header = True
            for i in headers:
                built_header += f'{i}: {headers[i]}\r\n'
            ffmpeg_params.append(built_header)
        try:
            stream_list = await FFprobe._read_streams(path, ffmpeg_params)
            have_video = False
            have_audio = False
            have_valid_video = False
            original_width = 0
            original_height = 0
            for stream in stream_list:
                codec_type = stream.get('codec_type', '')
                codec_name = stream.get('codec_name', '')
                image_codecs = ['png', 'jpeg', 'jpg']
                is_valid = not needed_image and codec_name in image_codecs
                if codec_type == 'video' and not is_valid:
                    have_video = True
                    original_width = int(stream.get('width', 0))
                    original_height = int(stream.get('height', 0))
                    if original_height and original_width:
                        have_valid_video = True
                elif codec_type == 'audio':
                    have_audio = True
            if needed_audio and not have_audio:
                have_audio = await FFprobe._has_decodable_audio(
                    path,
                    ffmpeg_params,
                )
            if needed_video:
                if not have_video:
                    raise NoVideoSourceFound(path)
                if not have_valid_video:
                    raise InvalidVideoProportion(
                        'Video proportion not found',
                    )
            if needed_audio:
                if not have_audio:
                    raise NoAudioSourceFound(path)
                if not needed_video:
                    return have_header
            if have_video:
                return original_width, original_height, have_header
        except FileNotFoundError:
            raise FFmpegNotInstalled(path)
