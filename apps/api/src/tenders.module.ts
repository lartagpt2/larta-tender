import { PgOfferRepository } from './data/offer-repository';
import { IncomingOfferFile } from './offer-files';
import { AssociateOfferDto } from './offer.dto';
import { ParseIntPipe } from '@nestjs/common';
import { TzExtractionRepository } from './extraction/extraction-repository';
import { ConfirmDraftDto } from './extraction/extraction.dto';
import { PayloadTooLargeException } from '@nestjs/common';
import { Res } from '@nestjs/common';
import { ApiHeader, ApiProduces } from '@nestjs/swagger';
import { FastifyReply } from 'fastify';
import { ValidateIf } from 'class-validator';
import { BadRequestException, Patch, Req } from '@nestjs/common';
import { ApiConsumes } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, ValidateNested } from 'class-validator';
import { resolve } from 'node:path';
import { FastifyRequest } from 'fastify';
import { ScopeItemDto, ScopePatchDto } from './scope.dto';
import { PgScopeRepository, ScopeRepository } from './data/scope-repository';
import { FileStore } from './storage/file-store';
import { specificationType } from './specification-file';
import {
  Body,
  Controller,
  DynamicModule,
  Get,
  Headers,
  Inject,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiProperty,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { isUUID, IsString, Length, Matches } from 'class-validator';
import { timingSafeEqual } from 'node:crypto';
import { Pool } from 'pg';
import { PgTenderRepository, TenderRepository } from './data/repository';
export class CreateTenderDto {
  @ApiProperty({ type: String, maxLength: 300, example: 'Synthetic tender' })
  @IsString()
  @Length(1, 300)
  @Matches(/\S/)
  title!: string;
  @ApiProperty({ type: String, required: false, enum: ['title', 'manual', 'specification'] })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['title', 'manual', 'specification'])
  creationMode?: 'title' | 'manual' | 'specification';
  @ApiProperty({ type: [ScopeItemDto], required: false, maxItems: 100 })
  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ScopeItemDto)
  items?: ScopeItemDto[];
}
export class TenderDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String }) title!: string;
  @ApiProperty({ type: Number }) revision!: number;
}
export class ScopeItemStateDto extends ScopeItemDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
}
export class ScopeStateDto extends TenderDto {
  @ApiProperty({ enum: ['lot', 'items'] }) selectionMode!: string;
  @ApiProperty({ type: Boolean }) specificationSkipped!: boolean;
  @ApiProperty({ type: String }) scopeStatus!: string;
  @ApiProperty({ type: [ScopeItemStateDto] }) items!: ScopeItemStateDto[];
}
export class SpecificationDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: String, description: 'uploaded means waiting, not parsed' }) status!: string;
}
export class LotDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: Number }) ordinal!: number;
}
export interface DataOptions {
  enabled?: boolean;
  environment?: string;
  token?: string;
  actorId?: string;
  repository?: TenderRepository;
  scopeRepository?: ScopeRepository;
  extractionRepository?: TzExtractionRepository;
  offerRepository?: PgOfferRepository;
}
class DataContext {
  readonly repository?: TenderRepository;
  readonly scope?: ScopeRepository;
  readonly extractions?: TzExtractionRepository;
  readonly offers?: PgOfferRepository;
  private pool?: Pool;
  constructor(private readonly options: DataOptions) {
    if (options.enabled && options.environment !== 'production') {
      this.repository =
        options.repository ??
        new PgTenderRepository(
          (this.pool = new Pool({ max: 5, connectionTimeoutMillis: 5000, statement_timeout: 10000 })),
        );
      this.scope = options.scopeRepository ?? (this.pool ? new PgScopeRepository(this.pool) : undefined);
      this.offers = options.offerRepository ?? (this.pool ? new PgOfferRepository(this.pool) : undefined);
      this.extractions =
        options.extractionRepository ?? (this.pool ? new TzExtractionRepository(this.pool) : undefined);
    }
  }
  actor(header?: string): string {
    const { token, actorId } = this.options;
    if (
      !this.repository ||
      !token ||
      token.length < 32 ||
      !actorId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(actorId)
    )
      throw new ServiceUnavailableException();
    const actual = Buffer.from(header ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new UnauthorizedException();
    return actorId;
  }
  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }
}
@ApiTags('tenders')
@ApiBearerAuth()
@ApiResponse({ status: 400, description: 'Invalid DTO or UUID' })
@ApiResponse({ status: 403, description: 'Read-only member' })
@ApiResponse({ status: 409, description: 'Stale revision or conflicting receipt' })
@ApiResponse({ status: 413, description: 'File exceeds 20 MiB' })
@ApiResponse({ status: 401, description: 'Development token required' })
@ApiResponse({ status: 404, description: 'Missing or inaccessible tender' })
@ApiResponse({ status: 503, description: 'Data access disabled pending migration approval' })
@Controller('tenders')
class TendersController {
  constructor(@Inject(DataContext) private readonly data: DataContext) {}
  @Get()
  @ApiOkResponse({ type: TenderDto, isArray: true, description: 'At most 100 visible tenders, newest first' })
  list(@Headers('authorization') header?: string) {
    const actor = this.data.actor(header);
    return this.data.repository!.list(actor);
  }
  @Post()
  @ApiBody({ type: CreateTenderDto })
  @ApiCreatedResponse({ type: TenderDto })
  create(
    @Headers('authorization') header: string | undefined,
    @Body(
      new ValidationPipe({
        expectedType: CreateTenderDto,
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )
    body: CreateTenderDto,
  ) {
    const actor = this.data.actor(header);
    if (body.creationMode === 'manual') {
      if (!body.items?.length) throw new BadRequestException();
      return this.scope().createManual(actor, body.title.trim(), body.items);
    }
    if (body.items?.length) throw new BadRequestException();
    return this.data.repository!.create(actor, body.title.trim());
  }
  @Get(':id')
  @ApiOkResponse({ type: TenderDto })
  get(@Headers('authorization') header: string | undefined, @Param('id', new ParseUUIDPipe()) id: string) {
    const actor = this.data.actor(header);
    return this.data.repository!.get(actor, id);
  }
  private scope(): ScopeRepository {
    if (!this.data.scope) throw new ServiceUnavailableException();
    return this.data.scope;
  }
  @Get(':id/scope')
  @ApiOkResponse({ type: ScopeStateDto })
  readScope(
    @Headers('authorization') header: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.scope().read(this.data.actor(header), id);
  }
  @Patch(':id/scope')
  @ApiOkResponse({ type: ScopeStateDto })
  @ApiBody({ type: ScopePatchDto })
  saveScope(
    @Headers('authorization') header: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(
      new ValidationPipe({
        expectedType: ScopePatchDto,
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )
    body: ScopePatchDto,
  ) {
    return this.scope().save(this.data.actor(header), id, body);
  }
  @Get(':id/tz')
  @ApiOkResponse({ type: SpecificationDto, isArray: true })
  specifications(
    @Headers('authorization') header: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.scope().documents(this.data.actor(header), id);
  }
  @Get(':id/tz/:documentId/original')
  @ApiProduces('application/octet-stream')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  async downloadSpecification(
    @Headers('authorization') header: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Res() reply: FastifyReply,
  ) {
    const document = await this.scope().original(this.data.actor(header), id, documentId);
    const storageRoot = process.env.STORAGE_ROOT;
    if (!storageRoot) throw new ServiceUnavailableException();
    const content = await new FileStore(storageRoot, resolve(__dirname, '../../../..')).get(document.key);
    return reply
      .header('content-type', 'application/octet-stream')
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(document.name)}`)
      .send(content);
  }
  @Post(':id/tz')
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiCreatedResponse({ type: SpecificationDto })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  async uploadSpecification(
    @Headers('authorization') header: string | undefined,
    @Headers('idempotency-key') key: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: FastifyRequest,
  ) {
    const actor = this.data.actor(header);
    if (!isUUID(key)) throw new BadRequestException();
    const scope = this.scope();
    await scope.assertWrite(actor, id);
    let file: { filename: string; mimetype: string; content: Buffer } | undefined;
    try {
      for await (const part of request.parts()) {
        if (part.type !== 'file' || part.fieldname !== 'file' || file) throw new BadRequestException();
        const content = await part.toBuffer();
        if (part.file.truncated) throw new PayloadTooLargeException();
        file = { filename: part.filename, mimetype: part.mimetype, content };
      }
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'FST_REQ_FILE_TOO_LARGE') throw new PayloadTooLargeException();
      if (
        code &&
        [
          'FST_PARTS_LIMIT',
          'FST_FILES_LIMIT',
          'FST_FIELDS_LIMIT',
          'FST_INVALID_MULTIPART_CONTENT_TYPE',
        ].includes(code)
      )
        throw new BadRequestException();
      throw error;
    }
    if (!file) throw new BadRequestException();
    const content = file.content;
    const mime = specificationType(file.filename, file.mimetype, content);
    const workspace = resolve(__dirname, '../../../..');
    const storageRoot = process.env.STORAGE_ROOT;
    if (!storageRoot) throw new ServiceUnavailableException();
    const blob = await new FileStore(storageRoot, workspace).put(content);
    return scope.attach(actor, id, key, blob, file.filename, mime);
  }
  private extractions(): TzExtractionRepository {
    if (!this.data.extractions) throw new ServiceUnavailableException();
    return this.data.extractions;
  }
  private store(): FileStore {
    const root = process.env.STORAGE_ROOT;
    if (!root) throw new ServiceUnavailableException();
    return new FileStore(root, resolve(__dirname, '../../../..'));
  }
  @Get(':id/tz/:documentId/draft')
  draft(
    @Headers('authorization') header: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
  ) {
    const actor = this.data.actor(header);
    return this.extractions().latest(actor, id, documentId);
  }
  @Post(':id/tz/:documentId/extractions')
  extract(
    @Headers('authorization') header: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
  ) {
    const actor = this.data.actor(header);
    return this.extractions().extract(actor, id, documentId, this.store());
  }
  @Get(':id/tz/:documentId/source/:page')
  source(
    @Headers('authorization') header: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Param('page', new ParseIntPipe()) page: number,
  ) {
    const actor = this.data.actor(header);
    if (page < 1 || page > 30) throw new BadRequestException();
    return this.extractions().page(actor, id, documentId, page, this.store());
  }
  @Post(':id/tz/:documentId/extractions/:runId/confirm')
  @ApiBody({ type: ConfirmDraftDto })
  @ApiCreatedResponse({ type: ScopeStateDto })
  confirm(
    @Headers('authorization') header: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Param('runId', new ParseUUIDPipe()) runId: string,
    @Body(
      new ValidationPipe({
        expectedType: ConfirmDraftDto,
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )
    input: ConfirmDraftDto,
  ) {
    const actor = this.data.actor(header);
    return this.extractions().confirm(actor, id, documentId, runId, input);
  }
  private offers(): PgOfferRepository {
    if (!this.data.offers) throw new ServiceUnavailableException();
    return this.data.offers;
  }
  @Get(':id/offers')
  offerList(@Headers('authorization') h: string | undefined, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.offers().list(this.data.actor(h), id);
  }
  @Get(':id/suppliers')
  offerSuppliers(
    @Headers('authorization') h: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.offers().suppliers(this.data.actor(h), id);
  }
  @Get(':id/offer-stages')
  offerStages(@Headers('authorization') h: string | undefined, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.offers().stages(this.data.actor(h), id);
  }
  @Patch(':id/offers/:documentId/association')
  association(
    @Headers('authorization') h: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('documentId', new ParseUUIDPipe()) doc: string,
    @Body(
      new ValidationPipe({
        expectedType: AssociateOfferDto,
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )
    body: AssociateOfferDto,
  ) {
    return this.offers().associate(
      this.data.actor(h),
      id,
      doc,
      body.revision,
      body.supplierId,
      body.note.trim(),
      body.newSupplier,
    );
  }
  @Get(':id/offers/:documentId/original')
  async offerOriginal(
    @Headers('authorization') h: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('documentId', new ParseUUIDPipe()) doc: string,
    @Res() reply: FastifyReply,
  ) {
    const original = await this.offers().originalOffer(this.data.actor(h), id, doc);
    return reply
      .header('content-type', 'application/octet-stream')
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(original.name)}`)
      .send(await this.store().get(original.key));
  }
  @Post(':id/offers/batches')
  @ApiConsumes('multipart/form-data')
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', format: 'uuid' } })
  async uploadOffers(
    @Headers('authorization') h: string | undefined,
    @Headers('idempotency-key') key: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: FastifyRequest,
    @Headers('x-tender-stage-id') stageId?: string,
  ) {
    const actor = this.data.actor(h),
      repo = this.offers();
    if (!isUUID(key)) throw new BadRequestException();
    await repo.assertWrite(actor, id);
    const files: IncomingOfferFile[] = [];
    let total = 0;
    try {
      for await (const part of request.parts({
        limits: { files: 10, parts: 10, fields: 0, fileSize: 20 * 1024 * 1024 },
      })) {
        if (part.type !== 'file' || part.fieldname !== 'files') throw new BadRequestException();
        const content = await part.toBuffer();
        total += content.length;
        if (part.file.truncated || total > 40 * 1024 * 1024) throw new PayloadTooLargeException();
        files.push({ name: part.filename, mime: part.mimetype, content });
      }
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (e instanceof PayloadTooLargeException || code?.startsWith('FST_'))
        await repo.rejectBatch(actor, id, 'multipart_limits');
      if (code === 'FST_REQ_FILE_TOO_LARGE') throw new PayloadTooLargeException();
      if (code?.startsWith('FST_')) throw new BadRequestException();
      throw e;
    }
    if (!files.length) throw new BadRequestException();
    if (stageId !== undefined && !isUUID(stageId)) throw new BadRequestException();
    return repo.batch(actor, id, key, files, this.store(), stageId);
  }
  @Get(':id/lots')
  @ApiOkResponse({ type: LotDto, isArray: true })
  lots(@Headers('authorization') header: string | undefined, @Param('id', new ParseUUIDPipe()) id: string) {
    const actor = this.data.actor(header);
    return this.data.repository!.lots(actor, id);
  }
}
@Module({})
export class TendersModule {
  static register(options: DataOptions): DynamicModule {
    return {
      module: TendersModule,
      controllers: [TendersController],
      providers: [{ provide: DataContext, useFactory: () => new DataContext(options) }],
    };
  }
}
