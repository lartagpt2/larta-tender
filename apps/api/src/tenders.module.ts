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
import { IsString, Length, Matches } from 'class-validator';
import { timingSafeEqual } from 'node:crypto';
import { Pool } from 'pg';
import { PgTenderRepository, TenderRepository } from './data/repository';
export class CreateTenderDto {
  @ApiProperty({ type: String, maxLength: 300, example: 'Synthetic tender' })
  @IsString()
  @Length(1, 300)
  @Matches(/\S/)
  title!: string;
}
export class TenderDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String }) title!: string;
  @ApiProperty({ type: Number }) revision!: number;
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
}
class DataContext {
  readonly repository?: TenderRepository;
  private pool?: Pool;
  constructor(private readonly options: DataOptions) {
    if (options.enabled && options.environment !== 'production') {
      this.repository =
        options.repository ??
        new PgTenderRepository(
          (this.pool = new Pool({ max: 5, connectionTimeoutMillis: 5000, statement_timeout: 10000 })),
        );
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
    return this.data.repository!.create(actor, body.title.trim());
  }
  @Get(':id')
  @ApiOkResponse({ type: TenderDto })
  get(@Headers('authorization') header: string | undefined, @Param('id', new ParseUUIDPipe()) id: string) {
    const actor = this.data.actor(header);
    return this.data.repository!.get(actor, id);
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
