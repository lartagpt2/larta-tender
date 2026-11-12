import { PgLifecycleRepository } from './lifecycle/lifecycle-repository';
import { LifecycleActionDto, LifecyclePageDto } from './lifecycle/lifecycle.dto';
import { ocrInventory } from './lifecycle/ocr-inventory';
import { PgAIRepository, aiOptions } from './document-ai/ai-repository';
import { CreateAIDto, ReviewAIDto } from './document-ai/ai.dto';
import { PgStageRepository } from './stages/stage-repository';
import {
  BaselineDto,
  AccreditationDto,
  ContactDto,
  DraftDto,
  ResponseDto,
  StageDto,
} from './stages/stage.dto';
import { Query } from '@nestjs/common';
import { PgVerificationRepository } from './comparison/verification-repository';
import { VerificationDto, CreateComparisonLotDto } from './comparison/verification.dto';
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
  verificationRepository?: PgVerificationRepository;
  stageRepository?: PgStageRepository;
  aiRepository?: PgAIRepository;
  lifecycleRepository?: PgLifecycleRepository;
  lifecycleEnabled?: boolean;
}
class DataContext {
  readonly repository?: TenderRepository;
  readonly scope?: ScopeRepository;
  readonly extractions?: TzExtractionRepository;
  readonly offers?: PgOfferRepository;
  readonly verifications?: PgVerificationRepository;
  readonly stages?: PgStageRepository;
  readonly ai?: PgAIRepository;
  readonly lifecycle?: PgLifecycleRepository;
  private pool?: Pool;
  constructor(private readonly options: DataOptions) {
    if (options.enabled && options.environment !== 'production') {
      this.repository =
        options.repository ??
        new PgTenderRepository(
          (this.pool = new Pool({ max: 5, connectionTimeoutMillis: 5000, statement_timeout: 10000 })),
        );
      this.scope = options.scopeRepository ?? (this.pool ? new PgScopeRepository(this.pool) : undefined);
      if (options.lifecycleEnabled ?? process.env.TENDER_LIFECYCLE_ENABLED === 'true') {
        const workspace = resolve(__dirname, '../../../..');
        const roots = [
          'storage-task004',
          'task008',
          'task008-e2e',
          'task008-gate-d',
          'task008-integration',
          'task008-tests',
          'task008e',
          'task008f',
          'task008g',
          'storage',
        ].map((p) => resolve(workspace, 'temp', p));
        if (process.env.STORAGE_ROOT) roots.push(process.env.STORAGE_ROOT);
        this.lifecycle =
          options.lifecycleRepository ??
          (this.pool
            ? new PgLifecycleRepository(this.pool, (id) => ocrInventory(workspace, roots, id))
            : undefined);
      }
      const aiConfig = aiOptions();
      this.ai =
        options.aiRepository ?? (this.pool && aiConfig ? new PgAIRepository(this.pool, aiConfig) : undefined);
      this.stages = options.stageRepository ?? (this.pool ? new PgStageRepository(this.pool) : undefined);
      this.verifications =
        options.verificationRepository ?? (this.pool ? new PgVerificationRepository(this.pool) : undefined);
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
  async onModuleInit() {
    await this.ai?.start();
  }
  async onModuleDestroy(): Promise<void> {
    await this.ai?.close();
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
  @Get('lifecycle/config')
  lifecycleConfig(@Headers('authorization') h?: string) {
    this.data.actor(h);
    return { enabled: !!this.data.lifecycle };
  }
  private lifecycle() {
    if (!this.data.lifecycle) throw new ServiceUnavailableException();
    return this.data.lifecycle;
  }
  @Get('lifecycle/page')
  lifecyclePage(
    @Headers('authorization') h: string | undefined,
    @Query(
      new ValidationPipe({
        expectedType: LifecyclePageDto,
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    input: LifecyclePageDto,
  ) {
    return this.lifecycle().page(this.data.actor(h), input);
  }
  @Get(':id/lifecycle')
  lifecyclePreview(
    @Headers('authorization') h: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.lifecycle().preview(this.data.actor(h), id);
  }
  @Post(':id/lifecycle')
  lifecycleAction(
    @Headers('authorization') h: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(
      new ValidationPipe({
        expectedType: LifecycleActionDto,
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    input: LifecycleActionDto,
  ) {
    return this.lifecycle().act(this.data.actor(h), id, input);
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
  private verifications(): PgVerificationRepository {
    if (!this.data.verifications) throw new ServiceUnavailableException();
    return this.data.verifications;
  }
  private comparisonOptions(lotId?: string, mode?: string, itemId?: string) {
    if (
      (lotId !== undefined && !isUUID(lotId)) ||
      (itemId !== undefined && !isUUID(itemId)) ||
      (mode !== undefined && !['lot', 'items'].includes(mode))
    )
      throw new BadRequestException();
    return { lotId, mode: mode as 'lot' | 'items' | undefined, itemId };
  }
  @Get(':id/verification')
  verificationContext(
    @Headers('authorization') h: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.verifications().context(this.data.actor(h), id);
  }
  @Post(':id/verification/lot')
  @ApiBody({ type: CreateComparisonLotDto })
  createComparisonLot(
    @Headers('authorization') h: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(
      new ValidationPipe({
        expectedType: CreateComparisonLotDto,
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )
    body: CreateComparisonLotDto,
  ) {
    return this.verifications().createDefaultLot(this.data.actor(h), id, body.expectedRevision);
  }
  @Post(':id/verification')
  @ApiBody({ type: VerificationDto })
  saveVerification(
    @Headers('authorization') h: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(
      new ValidationPipe({
        expectedType: VerificationDto,
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )
    body: VerificationDto,
  ) {
    return this.verifications().saveVerification(this.data.actor(h), id, body);
  }
  @Get(':id/comparison')
  comparison(
    @Headers('authorization') h: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('lotId') lotId?: string,
    @Query('mode') mode?: string,
    @Query('itemId') itemId?: string,
  ) {
    const options = this.comparisonOptions(lotId, mode, itemId);
    return this.verifications().comparison(
      this.data.actor(h),
      id,
      options.lotId,
      options.mode,
      options.itemId,
    );
  }
  @Get(':id/comparison.csv')
  async comparisonCsv(
    @Headers('authorization') h: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res() reply: FastifyReply,
    @Query('lotId') lotId?: string,
    @Query('mode') mode?: string,
    @Query('itemId') itemId?: string,
  ) {
    const options = this.comparisonOptions(lotId, mode, itemId);
    const content = await this.verifications().export(
      this.data.actor(h),
      id,
      options.lotId,
      options.mode,
      options.itemId,
    );
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', 'attachment; filename="comparison.csv"')
      .send(content);
  }
  private stages(): PgStageRepository {
    if (!this.data.stages) throw new ServiceUnavailableException();
    return this.data.stages;
  }
  @Get(':id/stages')
  stageContext(
    @Headers('authorization') h: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.stages().context(this.data.actor(h), id);
  }
  @Post(':id/stages')
  @ApiBody({ type: StageDto })
  createStage(
    @Headers('authorization') h: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(
      new ValidationPipe({
        expectedType: StageDto,
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )
    body: StageDto,
  ) {
    return this.stages().create(this.data.actor(h), id, body);
  }
  @Post(':id/stages/baseline')
  @ApiBody({ type: BaselineDto })
  fixBaseline(
    @Headers('authorization') h: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(
      new ValidationPipe({
        expectedType: BaselineDto,
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )
    input: BaselineDto,
  ) {
    return this.stages().baseline(this.data.actor(h), id, input);
  }
  @Post(':id/stages/:stageId/responses')
  @ApiBody({ type: ResponseDto })
  stageResponse(
    @Headers('authorization') h: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('stageId', new ParseUUIDPipe()) stageId: string,
    @Body(
      new ValidationPipe({
        expectedType: ResponseDto,
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )
    body: ResponseDto,
  ) {
    return this.stages().respond(this.data.actor(h), id, stageId, body);
  }
  @Post(':id/contacts/confirm')
  @ApiBody({ type: ContactDto })
  confirmContact(
    @Headers('authorization') h: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(
      new ValidationPipe({
        expectedType: ContactDto,
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )
    body: ContactDto,
  ) {
    return this.stages().confirmContact(this.data.actor(h), id, body);
  }
  @Post(':id/stages/:stageId/drafts')
  @ApiBody({ type: DraftDto })
  saveStageDraft(
    @Headers('authorization') h: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('stageId', new ParseUUIDPipe()) stageId: string,
    @Body(
      new ValidationPipe({
        expectedType: DraftDto,
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )
    body: DraftDto,
  ) {
    return this.stages().draft(this.data.actor(h), id, stageId, body);
  }
  @Post(':id/accreditations')
  @ApiBody({ type: AccreditationDto })
  recordAccreditation(
    @Headers('authorization') h: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(
      new ValidationPipe({
        expectedType: AccreditationDto,
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )
    body: AccreditationDto,
  ) {
    return this.stages().accreditation(this.data.actor(h), id, body);
  }
  @Post(':id/accreditations/files')
  @ApiConsumes('multipart/form-data')
  async uploadAccreditation(
    @Headers('authorization') h: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') key: string,
    @Req() request: FastifyRequest,
  ) {
    const actor = this.data.actor(h);
    if (!isUUID(key)) throw new BadRequestException();
    await this.stages().assertWrite(actor, id);
    const parts = request.parts();
    let file: { name: string; mime: string; content: Buffer } | undefined;
    try {
      for await (const part of parts) {
        if (part.type !== 'file' || part.fieldname !== 'file' || file) throw new BadRequestException();
        const content = await part.toBuffer();
        if (part.file.truncated) throw new PayloadTooLargeException();
        file = {
          name: part.filename,
          mime: specificationType(part.filename, part.mimetype, content),
          content,
        };
      }
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'FST_REQ_FILE_TOO_LARGE') throw new PayloadTooLargeException();
      if (code?.startsWith('FST_')) throw new BadRequestException();
      throw e;
    }
    if (!file) throw new BadRequestException();
    return this.stages().upload(actor, id, key, await this.store().put(file.content), file.name, file.mime);
  }
  private ai(): PgAIRepository {
    if (!this.data.ai) throw new ServiceUnavailableException();
    return this.data.ai;
  }
  @Get(':id/document-ai')
  aiList(@Headers('authorization') h: string | undefined, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.ai().list(this.data.actor(h), id);
  }
  @Get(':id/document-ai/:jobId')
  aiGet(
    @Headers('authorization') h: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('jobId') jobId: string,
  ) {
    return this.ai().get(this.data.actor(h), id, jobId);
  }
  @Post(':id/document-ai')
  @ApiBody({ type: CreateAIDto })
  aiCreate(
    @Headers('authorization') h: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(
      new ValidationPipe({
        expectedType: CreateAIDto,
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )
    input: CreateAIDto,
  ) {
    return this.ai().create(this.data.actor(h), id, input);
  }
  @Post(':id/document-ai/:jobId/review')
  @ApiBody({ type: ReviewAIDto })
  aiReview(
    @Headers('authorization') h: string | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('jobId') jobId: string,
    @Body(
      new ValidationPipe({
        expectedType: ReviewAIDto,
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )
    input: ReviewAIDto,
  ) {
    return this.ai().review(this.data.actor(h), id, jobId, input);
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
