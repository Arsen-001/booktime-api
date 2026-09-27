import { logger } from '../../common/logging/logger.js';

/**
 * SMS/WhatsApp бизнеса (В-08): бизнес подключает СВОЕГО провайдера за свой счёт; настройки — на бизнес. Пока
 * провайдеры не подключены — заглушка.
 */
export interface BusinessMessage {
  businessId: string;
  to: string;
  text: string;
  channel: 'sms' | 'whatsapp';
}

export interface BusinessMessenger {
  send(message: BusinessMessage): Promise<{ delivered: boolean }>;
}

export class FakeBusinessMessenger implements BusinessMessenger {
  async send(message: BusinessMessage): Promise<{ delivered: boolean }> {
    logger.info({ businessId: message.businessId, channel: message.channel }, `[fake business-sms] ${message.text.slice(0, 60)}`);
    return { delivered: true };
  }
}
