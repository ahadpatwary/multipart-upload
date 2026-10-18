import { Module } from '@nestjs/common';
import { fromContainer } from './container';
import { AppConfig } from './common/config/app-config';
import { UploadService } from './upload/application/upload-service';
import { JwtAuthGuard } from './upload/http/jwt-auth.guard';
import { UploadController } from './upload/http/upload.controller';

@Module({
  controllers: [UploadController],
  providers: [fromContainer(AppConfig), fromContainer(UploadService), JwtAuthGuard],
})
export class AppModule {}
