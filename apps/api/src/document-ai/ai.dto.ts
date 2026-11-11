import { Type } from 'class-transformer';
import { ValidateNested } from 'class-validator';
import { VerificationDto } from '../comparison/verification.dto';
import { IsUUID, ValidateIf, IsIn, IsInt, Min, IsObject, IsString, Length } from 'class-validator';
export class CreateAIDto {
  @IsUUID() documentId!: string;
  @ValidateIf((_o, v) => v !== undefined) @IsUUID() receiptId?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsUUID() supplierId?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsUUID() lotId?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsString() @Length(64, 64) retryOf?: string;
  @IsIn(['offer', 'specification']) kind!: 'offer' | 'specification';
}
export class ReviewAIDto {
  @ValidateIf((_o, v) => v !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => VerificationDto)
  verification?: VerificationDto;
  @IsInt() @Min(1) revision!: number;
  @IsObject() fields!: Record<string, string | null>;
  @IsString() @Length(1, 1000) note!: string;
}
