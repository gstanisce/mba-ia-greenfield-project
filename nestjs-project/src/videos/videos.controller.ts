import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { THUMBNAIL_CONTENT_TYPE } from '../video-processing/video-processing.constants';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { SignUploadPartsDto } from './dto/sign-upload-parts.dto';
import { VideoDetailsResponseDto } from './dto/video-details-response.dto';
import {
  CompleteUploadResponseDto,
  InitiateUploadResponseDto,
  ListUploadedPartsResponseDto,
  SignUploadPartsResponseDto,
} from './dto/upload-responses.dto';
import { attachmentDisposition } from './http-headers.util';
import { ParseVideoSlugPipe } from './pipes/parse-video-slug.pipe';
import { VideoProcessingStatus } from './entities/video.entity';
import { toVideoDetails } from './video-details.mapper';
import type { OriginalStream } from './videos.service';
import { VideosService } from './videos.service';

const SLUG_PARAM = {
  name: 'slug',
  description: 'Public 11-character video identifier',
  example: 'Ab3dE5fG7hI',
};

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post('uploads')
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Creates the video as a draft (uploading/draft) and opens a multipart upload in storage.',
  })
  @ApiBody({ type: InitiateUploadDto })
  @ApiResponse({ status: 201, type: InitiateUploadResponseDto })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResponseDto> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':slug/upload/parts')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiParam(SLUG_PARAM)
  @ApiOperation({
    summary: 'Get presigned URLs for upload parts',
    description:
      'Returns one presigned PUT URL per requested part. The bytes go directly to storage.',
  })
  @ApiBody({ type: SignUploadPartsDto })
  @ApiResponse({ status: 200, type: SignUploadPartsResponseDto })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or part number out of range',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or owned by another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Upload is not in progress',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async signUploadParts(
    @CurrentUser() user: JwtPayload,
    @Param('slug', ParseVideoSlugPipe) slug: string,
    @Body() dto: SignUploadPartsDto,
  ): Promise<SignUploadPartsResponseDto> {
    return this.videosService.signUploadParts(user.sub, slug, dto.partNumbers);
  }

  @Get(':slug/upload/parts')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiParam(SLUG_PARAM)
  @ApiOperation({
    summary: 'List the parts already received',
    description:
      'Lists the parts storage has received, so an interrupted upload can resume.',
  })
  @ApiResponse({ status: 200, type: ListUploadedPartsResponseDto })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or owned by another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Upload is not in progress',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async listUploadedParts(
    @CurrentUser() user: JwtPayload,
    @Param('slug', ParseVideoSlugPipe) slug: string,
  ): Promise<ListUploadedPartsResponseDto> {
    const parts = await this.videosService.listUploadedParts(user.sub, slug);
    return { parts };
  }

  @Post(':slug/upload/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth('access-token')
  @ApiParam(SLUG_PARAM)
  @ApiOperation({
    summary: 'Complete the upload and start processing',
    description:
      'Completes the multipart upload, checks the real size and enqueues the video for processing.',
  })
  @ApiBody({ type: CompleteUploadDto })
  @ApiResponse({ status: 202, type: CompleteUploadResponseDto })
  @ApiResponse({
    status: 400,
    description: 'Validation failed, or storage rejected the part list',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or owned by another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Upload is not in progress',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description: 'Stored file is larger than the declared size',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('slug', ParseVideoSlugPipe) slug: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    await this.videosService.completeUpload(user.sub, slug, dto.parts);
    return { slug, processingStatus: VideoProcessingStatus.PROCESSING };
  }

  @Delete(':slug/upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiParam(SLUG_PARAM)
  @ApiOperation({
    summary: 'Abort the upload',
    description:
      'Aborts the multipart upload in storage and removes the draft video.',
  })
  @ApiResponse({ status: 204, description: 'Upload aborted' })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or owned by another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Upload is not in progress',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('slug', ParseVideoSlugPipe) slug: string,
  ): Promise<void> {
    await this.videosService.abortUpload(user.sub, slug);
  }

  @Get(':slug')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiParam(SLUG_PARAM)
  @ApiOperation({
    summary: 'Get the video details',
    description:
      'Returns the video state and metadata. Available in any processing status.',
  })
  @ApiResponse({ status: 200, type: VideoDetailsResponseDto })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or owned by another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getVideo(
    @CurrentUser() user: JwtPayload,
    @Param('slug', ParseVideoSlugPipe) slug: string,
  ): Promise<VideoDetailsResponseDto> {
    return toVideoDetails(
      await this.videosService.getOwnedVideo(user.sub, slug),
    );
  }

  @Get(':slug/stream')
  @ApiBearerAuth('access-token')
  @ApiParam(SLUG_PARAM)
  @ApiProduces('application/octet-stream')
  @ApiOperation({
    summary: 'Stream the original video',
    description:
      'Proxies the original through the API. A Range header returns 206 with Content-Range.',
  })
  @ApiResponse({ status: 200, description: 'Full video body' })
  @ApiResponse({ status: 206, description: 'Requested byte range' })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or owned by another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 416,
    description: 'Range is malformed, multiple, or starts past the end',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(
    @CurrentUser() user: JwtPayload,
    @Param('slug', ParseVideoSlugPipe) slug: string,
    @Headers('range') rangeHeader: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const original = await this.videosService.openOriginal(
      user.sub,
      slug,
      rangeHeader,
    );
    return this.toOriginalResponse(res, original, false);
  }

  @Get(':slug/download')
  @ApiBearerAuth('access-token')
  @ApiParam(SLUG_PARAM)
  @ApiProduces('application/octet-stream')
  @ApiOperation({
    summary: 'Download the original video',
    description:
      'Same as stream, sent as an attachment named after the original file. Accepts Range to resume.',
  })
  @ApiResponse({ status: 200, description: 'Full video as an attachment' })
  @ApiResponse({
    status: 206,
    description: 'Requested byte range as an attachment',
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or owned by another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 416,
    description: 'Range is malformed, multiple, or starts past the end',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @CurrentUser() user: JwtPayload,
    @Param('slug', ParseVideoSlugPipe) slug: string,
    @Headers('range') rangeHeader: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const original = await this.videosService.openOriginal(
      user.sub,
      slug,
      rangeHeader,
    );
    return this.toOriginalResponse(res, original, true);
  }

  @Get(':slug/thumbnail')
  @ApiBearerAuth('access-token')
  @ApiParam(SLUG_PARAM)
  @ApiProduces('image/jpeg')
  @ApiOperation({
    summary: 'Get the video thumbnail',
    description: 'Returns the JPEG thumbnail generated by the worker.',
  })
  @ApiResponse({ status: 200, description: 'JPEG thumbnail' })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or owned by another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async thumbnail(
    @CurrentUser() user: JwtPayload,
    @Param('slug', ParseVideoSlugPipe) slug: string,
  ): Promise<StreamableFile> {
    const thumbnail = await this.videosService.openThumbnail(user.sub, slug);
    return new StreamableFile(thumbnail.body, {
      type: THUMBNAIL_CONTENT_TYPE,
      length: thumbnail.contentLength,
    });
  }

  // Status and headers are HTTP concerns, so they are set here; the bytes come from the service.
  private toOriginalResponse(
    res: Response,
    original: OriginalStream,
    attachment: boolean,
  ): StreamableFile {
    res.setHeader('Accept-Ranges', 'bytes');
    if (original.range) {
      res.status(HttpStatus.PARTIAL_CONTENT);
      res.setHeader(
        'Content-Range',
        `bytes ${original.range.start}-${original.range.end}/${original.totalBytes}`,
      );
    }
    return new StreamableFile(original.body, {
      type: original.contentType,
      length: original.contentLength,
      disposition: attachment
        ? attachmentDisposition(original.fileName)
        : undefined,
    });
  }
}
