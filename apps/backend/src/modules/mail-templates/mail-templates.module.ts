import { Module } from '@nestjs/common';
import { MailTemplatesController } from './mail-templates.controller';
import { MailTemplatesService } from './mail-templates.service';

@Module({
  controllers: [MailTemplatesController],
  providers: [MailTemplatesService],
})
export class MailTemplatesModule {}
