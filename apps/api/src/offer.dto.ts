import { Type, Transform } from 'class-transformer';
import {
  IsEmail,
  IsInt,
  IsObject,
  IsString,
  IsUUID,
  Length,
  Matches,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const optionalTrim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || undefined : value;
export class NewSupplierDto {
  @Transform(trim) @IsString() @Length(1, 300) @Matches(/\S/) name!: string;
  @Transform(optionalTrim)
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @Length(1, 64)
  registrationNumber?: string;
  @Transform(optionalTrim) @ValidateIf((_o, v) => v !== undefined) @IsEmail() @Length(3, 254) email?: string;
  @Transform(optionalTrim)
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @Length(1, 1000)
  comment?: string;
}
export class AssociateOfferDto {
  @IsInt() @Min(1) revision!: number;
  @ValidateIf((_o, v) => v !== undefined && v !== null) @IsUUID() supplierId?: string | null;
  @ValidateIf((_o, v) => v !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => NewSupplierDto)
  newSupplier?: NewSupplierDto;
  @Transform(trim) @IsString() @Length(1, 1000) @Matches(/\S/) note!: string;
}
