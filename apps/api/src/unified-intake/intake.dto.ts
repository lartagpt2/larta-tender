import { IsIn, IsInt, IsString, Length, Matches, Min, ValidateIf } from 'class-validator';
import { Category, categories } from './classification';
export class ClassificationDecisionDto {
  @IsInt() @Min(1) expectedRevision!: number;
  @IsIn(['confirm', 'change', 'reject']) action!: 'confirm' | 'change' | 'reject';
  @ValidateIf((_o, v) => v !== undefined) @IsIn(categories) type?: Category;
  @IsString() @Length(1, 1000) @Matches(/\S/) note!: string;
}
export class ReclassifyDto {
  @IsInt() @Min(1) expectedRunRevision!: number;
  @IsString() @Length(1, 1000) @Matches(/\S/) reason!: string;
}
