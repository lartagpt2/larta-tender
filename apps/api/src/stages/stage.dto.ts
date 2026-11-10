import {
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ArrayMaxSize,
  ValidateIf,
} from 'class-validator';
export class RevisionDto {
  @IsInt() @Min(1) @Max(1000000000) expectedRevision!: number;
}
export class StageDto extends RevisionDto {
  @IsIn(['clarification', 'round', 'negotiation']) kind!: 'clarification' | 'round' | 'negotiation';
  @IsString() @Length(1, 300) @Matches(/\S/) label!: string;
  @IsString() @MaxLength(2000) comment = '';
}
export class ResponseDto extends RevisionDto {
  @IsUUID() offerId!: string;
  @IsIn(['received', 'no_reply', 'withdrawn']) status!: 'received' | 'no_reply' | 'withdrawn';
  @ValidateIf((_o, v) => v !== undefined) @IsUUID() versionId?: string;
  @IsString() @Length(1, 1000) @Matches(/\S/) note!: string;
}
export class ContactDto extends RevisionDto {
  @IsUUID() supplierId!: string;
  @IsEmail() @MaxLength(254) email!: string;
  @IsUUID() documentId!: string;
  @IsString() @Length(1, 1000) @Matches(/\S/) note!: string;
}
export class DraftDto extends RevisionDto {
  @IsUUID() supplierId!: string;
  @IsArray() @ArrayMaxSize(20) @IsUUID(undefined, { each: true }) contactIds!: string[];
  @IsString() @Length(1, 300) @Matches(/\S/) subject!: string;
  @IsString() @Length(1, 20000) @Matches(/\S/) body!: string;
  @IsOptional() @IsUUID() previousId?: string;
}
export class AccreditationDto extends RevisionDto {
  @IsUUID() supplierId!: string;
  @IsUUID() documentId!: string;
  @IsISO8601({ strict: true }) assessedAt!: string;
  @IsIn(['passed', 'conditional', 'pending', 'failed', 'no_conclusion']) status!: string;
  @IsString() @Length(1, 1000) @Matches(/\S/) source!: string;
  @IsString() @MaxLength(2000) note = '';
}

export class BaselineDto extends RevisionDto {
  @IsUUID() offerId!: string;
  @IsUUID() versionId!: string;
  @IsString() @Length(1, 1000) @Matches(/\S/) note!: string;
}
