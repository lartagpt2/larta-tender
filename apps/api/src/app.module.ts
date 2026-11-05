import { Controller, Get, Module } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
@ApiTags('health')
@Controller()
export class HealthController {
  @Get('health') health() {
    return { status: 'ok', persistence: 'not-configured' };
  }
}
@Module({ controllers: [HealthController] })
export class AppModule {}
