import { logger } from '../../common/logging/logger.js';

/** Почта (PLAN.md §10): провайдер не выбран — заглушка пишет письмо в лог */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface MailSender {
  send(message: MailMessage): Promise<void>;
}

export class FakeMailSender implements MailSender {
  async send(message: MailMessage): Promise<void> {
    logger.info({ to: message.to }, `[fake mail] ${message.subject}`);
  }
}
