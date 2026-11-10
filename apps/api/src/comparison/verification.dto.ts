import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  Equals,
  IsArray,
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsObject,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
export const currencies = ['RUB', 'USD', 'EUR', 'CNY'] as const;
export const moneyPattern = /^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/;
const known = (_o: unknown, v: unknown) => v !== undefined && v !== null;
export class CommercialFieldsDto {
  @ValidateIf(known) @Matches(moneyPattern) amount: string | null = null;
  @ValidateIf(known) @IsIn(currencies) currency: string | null = null;
  @IsIn(['included', 'excluded', 'unknown']) vatMode: 'included' | 'excluded' | 'unknown' = 'unknown';
  @ValidateIf(known) @IsString() @Length(1, 1000) @Matches(/\S/) paymentTerms: string | null = null;
  @ValidateIf(known) @IsString() @Length(1, 1000) @Matches(/\S/) deliveryTerms: string | null = null;
  @IsIn(['matches', 'partial', 'unknown']) compliance: 'matches' | 'partial' | 'unknown' = 'unknown';
}
export class VerifiedItemDto {
  @IsUUID() lotItemId!: string;
  @Matches(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/) @Matches(/[1-9]/) quantity!: string;
  @IsString() @Length(1, 40) @Matches(/\S/) unit!: string;
  @ValidateIf(known) @Matches(moneyPattern) unitPrice: string | null = null;
}
export class VerifiedCostDto {
  @IsString() @Length(1, 300) @Matches(/\S/) name!: string;
  @IsIn(['included', 'add', 'unknown']) treatment!: 'included' | 'add' | 'unknown';
  @ValidateIf(known) @Matches(moneyPattern) amount: string | null = null;
  @ValidateIf(known) @IsIn(currencies) currency: string | null = null;
}
export class VerificationDto {
  @IsUUID() supplierId!: string;
  @IsUUID() lotId!: string;
  @IsUUID() documentId!: string;
  @IsUUID() receiptId!: string;
  @IsInt() @Min(0) @Max(1000000000) expectedVersion!: number;
  @Equals(true) contextConfirmed!: boolean;
  @IsIn(['draft', 'confirm']) intent!: 'draft' | 'confirm';
  @IsDefined() @IsObject() @ValidateNested() @Type(() => CommercialFieldsDto) fields!: CommercialFieldsDto;
  @ValidateIf((_o, v) => v !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => CommercialFieldsDto)
  original?: CommercialFieldsDto;
  @IsIn(['document', 'phone', 'email', 'other']) sourceType!: 'document' | 'phone' | 'email' | 'other';
  @IsString() @Length(1, 1000) @Matches(/\S/) sourceNote!: string;
  @IsBoolean() costsEnabled = false;
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => VerifiedCostDto)
  costs: VerifiedCostDto[] = [];
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => VerifiedItemDto)
  items: VerifiedItemDto[] = [];
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Length(1, 500, { each: true })
  @Matches(/\S/, { each: true })
  newQuestions: string[] = [];
  @IsArray() @ArrayMaxSize(100) @IsUUID('all', { each: true }) resolveQuestionIds: string[] = [];
}

export class CreateComparisonLotDto {
  @IsInt() @Min(1) @Max(1000000000) expectedRevision!: number;
}
