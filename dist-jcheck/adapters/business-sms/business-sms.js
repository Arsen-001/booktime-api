import { logger } from '../../common/logging/logger.js';
export class FakeBusinessMessenger {
    async send(message) {
        logger.info({ businessId: message.businessId, channel: message.channel }, `[fake business-sms] ${message.text.slice(0, 60)}`);
        return { delivered: true };
    }
}
//# sourceMappingURL=business-sms.js.map