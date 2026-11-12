import { IsIn, IsInt, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
export class LifecyclePageDto {
  @IsIn(['active', 'archived', 'trash']) state: 'active' | 'archived' | 'trash' = 'active';
  @Type(() => Number) @IsInt() @Min(1) @Max(1000000) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 25;
  @IsString() @Length(0, 300) search = '';
}
export class LifecycleActionDto {
  @IsIn(['archive', 'restore', 'trash', 'classify_synthetic', 'classify_working']) action!: string;
  @IsUUID() confirmationId!: string;
  @IsString() @Length(1, 300) confirmationTitle!: string;
  @IsString() @Matches(/^[a-f0-9]{64}$/) previewHash!: string;
  @IsString() @Length(10, 2000) reason!: string;
  @IsString() @Length(0, 4000) evidence = '';
}
