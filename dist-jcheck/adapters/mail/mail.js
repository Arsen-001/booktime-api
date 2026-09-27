import { logger } from '../../common/logging/logger.js';
export class FakeMailSender {
    async send(message) {
        logger.info({ to: message.to }, `[fake mail] ${message.subject}`);
    }
}
//# sourceMappingURL=mail.js.map