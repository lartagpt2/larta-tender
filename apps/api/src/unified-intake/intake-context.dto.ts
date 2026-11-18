import { IsUUID, Matches } from 'class-validator';
export class IntakeContextDto {
  @IsUUID() receiptId!: string;
  @IsUUID() resultId!: string;
  @IsUUID() companyRevisionId!: string;
  @IsUUID() classificationRevisionId!: string;
  @IsUUID() associationRevisionId!: string;
  @Matches(/^[a-f0-9]{64}$/) contextToken!: string;
  @IsUUID() draftId!: string;
  @IsUUID() operationKey!: string;
}
