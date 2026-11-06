import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, Min, ValidateNested } from 'class-validator';
import { ScopeItemDto } from '../scope.dto';
export class ConfirmDraftItemDto extends ScopeItemDto {
  @ApiProperty({ type: Number }) @IsInt() @Min(1) sourceIndex!: number;
}
export class ConfirmDraftDto {
  @ApiProperty({ type: Number }) @IsInt() @Min(1) revision!: number;
  @ApiProperty({ type: [ConfirmDraftItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ConfirmDraftItemDto)
  items!: ConfirmDraftItemDto[];
}
