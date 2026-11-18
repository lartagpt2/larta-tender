import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
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
import { ClassificationDecisionDto } from './intake.dto';
import { CommercialFieldsDto, VerifiedItemDto } from '../comparison/verification.dto';
const optional = (_o: unknown, v: unknown) => v !== undefined;
export class ImpactAckDto {
  @ValidateIf(optional) @IsString() @Matches(/^[a-f0-9]{64}$/) impactPreviewHash?: string;
  @ValidateIf(optional) @IsBoolean() acknowledgeImpact?: boolean;
}
export class ReviewClassificationDto extends ClassificationDecisionDto {
  @ValidateIf(optional) @IsString() @Matches(/^[a-f0-9]{64}$/) impactPreviewHash?: string;
  @ValidateIf(optional) @IsBoolean() acknowledgeImpact?: boolean;
}
export class CompanyChangesDto {
  @ValidateIf(optional) @IsString() @Length(1, 300) @Matches(/\S/) legalName?: string;
  @ValidateIf(optional) @IsString() @Matches(/^[A-Z]{2}$/) country?: string;
  @ValidateIf(optional) @IsString() @Length(1, 80) registrationNumber?: string;
  @ValidateIf(optional) @IsString() @Length(1, 400) address?: string;
  @ValidateIf(optional) @IsString() @Length(1, 300) @Matches(/^[^\s@]+@[^\s@]+\.[^\s@]+$/) email?: string;
}
export class CompanyDecisionDto {
  @IsInt() @Min(1) expectedRevision!: number;
  @IsIn(['edit', 'confirm', 'choose_existing', 'reject', 'defer']) action!:
    'edit' | 'confirm' | 'choose_existing' | 'reject' | 'defer';
  @IsString() @Length(1, 1000) @Matches(/\S/) note!: string;
  @ValidateIf(optional) @IsBoolean() createFromRevision?: boolean;
  @ValidateIf(optional) @IsUUID() existingSupplierId?: string;
  @ValidateIf(optional)
  @IsObject()
  @ValidateNested()
  @Type(() => CompanyChangesDto)
  changes?: CompanyChangesDto;
}
export class AssociationDecisionDto extends ImpactAckDto {
  @IsInt() @Min(1) expectedRevision!: number;
  @IsIn(['confirm', 'change', 'reject', 'defer']) action!: 'confirm' | 'change' | 'reject' | 'defer';
  @ValidateIf(optional) @IsUUID() companyId?: string;
  @ValidateIf(optional) @IsUUID() targetReceiptId?: string;
  @IsString() @Length(1, 1000) @Matches(/\S/) note!: string;
}
export class ObservationDecisionDto extends ImpactAckDto {
  @IsInt() @Min(0) expectedRevision!: number;
  @IsIn(['reject']) action!: 'reject';
  @IsString() @Length(1, 1000) @Matches(/\S/) note!: string;
}
export class WorkspaceQueryDto {
  @ValidateIf(optional) @IsUUID() receiptId?: string;
  @IsIn(['received_asc', 'received_desc', 'name']) sort: 'received_asc' | 'received_desc' | 'name' =
    'received_asc';
  @Type(() => Number) @IsInt() @Min(1) @Max(1000000) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 10;
  @IsIn(['all', 'preliminary', 'unassigned', 'review', 'errors']) filter:
    'all' | 'preliminary' | 'unassigned' | 'review' | 'errors' = 'all';
}
export class TransferDraftDto {
  @IsInt() @Min(0) expectedRevision!: number;
  @Matches(/^[a-f0-9]{64}$/) contextToken!: string;
  @IsUUID() lotId!: string;
  @IsArray()
  @ArrayMaxSize(6)
  @IsIn(['amount', 'currency', 'vatMode', 'paymentTerms', 'deliveryTerms', 'compliance'], { each: true })
  selectedFields: string[] = [];
  @IsObject() @ValidateNested() @Type(() => CommercialFieldsDto) form!: CommercialFieldsDto;
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => VerifiedItemDto)
  items: VerifiedItemDto[] = [];
  @IsString() @Length(1, 1000) @Matches(/\S/) note!: string;
}
