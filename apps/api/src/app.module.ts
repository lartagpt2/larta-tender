import { Controller, Get, Inject, Injectable, Module } from '@nestjs/common';
import { ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
export class HealthDto {
  @ApiProperty({ example: 'ok' }) status = 'ok';
  @ApiProperty({ example: 'larta-tender' }) service = 'larta-tender';
  @ApiProperty({ example: 'not-configured', description: 'Database connection is not probed.' })
  persistence = 'not-configured';
}
@Injectable()
export class HealthService {
  getStatus(): HealthDto {
    return new HealthDto();
  }
}
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly healthService: HealthService) {}
  @Get()
  @ApiOkResponse({ type: HealthDto })
  health(): HealthDto {
    return this.healthService.getStatus();
  }
}
@Module({ controllers: [HealthController], providers: [HealthService] })
export class AppModule {}
