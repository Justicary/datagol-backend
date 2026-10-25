import { z } from 'zod';

/**
 * Formato oficial de un Bot Token de @BotFather: `<bot_id>:<alphanumeric_secret>`
 */
export const telegramBotTokenSchema = z
    .string()
    .trim()
    .regex(/^\d{5,16}:[A-Za-z0-9_-]{20,64}$/, {
        message: 'El token del Bot de Telegram no tiene un formato válido (esperado: <bot_id>:<secret>).',
    });

export const upsertTelegramConnectionBodySchema = z.object({
    botToken: telegramBotTokenSchema,
});

export type UpsertTelegramConnectionBody = z.infer<typeof upsertTelegramConnectionBodySchema>;

export const validateTelegramTokenBodySchema = z.object({
    botToken: telegramBotTokenSchema.optional(),
});

export type ValidateTelegramTokenBody = z.infer<typeof validateTelegramTokenBodySchema>;

export const telegramIdentityIdParamsSchema = z.object({
    id: z.string().uuid({ message: 'El parámetro "id" debe ser un UUID válido.' }),
    identityId: z.string().uuid({ message: 'El parámetro "identityId" debe ser un UUID válido.' }),
});

export const telegramWebhookParamsSchema = z.object({
    webhookToken: z
        .string()
        .trim()
        .regex(/^[a-fA-F0-9]{32,128}$/, { message: 'webhookToken inválido.' }),
});

/**
 * Esquema Zod para el objeto User de Telegram Bot API
 */
export const telegramUserSchema = z.object({
    id: z.number().int(),
    is_bot: z.boolean().optional(),
    first_name: z.string(),
    last_name: z.string().optional(),
    username: z.string().optional(),
    language_code: z.string().optional(),
});

/**
 * Esquema Zod para el objeto Chat de Telegram Bot API
 */
export const telegramChatSchema = z.object({
    id: z.number().int(),
    type: z.enum(['private', 'group', 'supergroup', 'channel']),
    title: z.string().optional(),
    username: z.string().optional(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
});

/**
 * Esquema Zod para el objeto Message de Telegram Bot API
 */
export const telegramMessageSchema = z.object({
    message_id: z.number().int(),
    from: telegramUserSchema.optional(),
    date: z.number().int(),
    chat: telegramChatSchema,
    text: z.string().optional(),
});

/**
 * Esquema Zod para el objeto Update de Telegram Bot API
 */
export const telegramUpdateSchema = z.object({
    update_id: z.number().int().nonnegative(),
    message: telegramMessageSchema.optional(),
    edited_message: telegramMessageSchema.optional(),
});

export type TelegramUpdatePayload = z.infer<typeof telegramUpdateSchema>;
export type TelegramMessagePayload = z.infer<typeof telegramMessageSchema>;
