import { ValidateIf } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsString,
  Length,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
export class ScopeItemDto {
  @ApiProperty({ type: String, maxLength: 500 }) @IsString() @Length(1, 500) @Matches(/\S/) name!: string;
  @ApiProperty({ type: String, example: '2.000001', description: 'Positive NUMERIC(18,6) as text' })
  @IsString()
  @Matches(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/)
  @Matches(/[1-9]/)
  quantity!: string;
  @ApiProperty({ type: String, maxLength: 40 }) @IsString() @Length(1, 40) @Matches(/\S/) unit!: string;
}
export class ScopePatchDto {
  @ApiProperty({ type: Number, minimum: 1 }) @IsInt() @Min(1) revision!: number;
  @ApiPropertyOptional({ enum: ['lot', 'items'] })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['lot', 'items'])
  selectionMode?: 'lot' | 'items';
  @ApiPropertyOptional({ type: Boolean })
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  specificationSkipped?: boolean;
  @ApiPropertyOptional({ type: [ScopeItemDto], maxItems: 100 })
  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ScopeItemDto)
  items?: ScopeItemDto[];
}
