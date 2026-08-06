import { IVoiceProvider } from './voice-provider.interface.js';
import { ElevenLabsAdapter } from './ElevenLabsAdapter.js';
import { VapiAdapter } from './VapiAdapter.js';
import { logger } from '../../lib/logger.js';

export class VoiceProviderFactory {
  private static elevenLabsInstance = new ElevenLabsAdapter();
  private static vapiInstance = new VapiAdapter();

  /**
   * Resuelve la instancia del proveedor de voz según la configuración
   */
  static getProvider(providerType?: string): IVoiceProvider {
    const normalized = (providerType || 'elevenlabs').toLowerCase();

    switch (normalized) {
      case 'elevenlabs':
      case 'elevenlabs_agents':
      case 'convai':
        return this.elevenLabsInstance;

      case 'vapi':
        return this.vapiInstance;

      default:
        logger.warn({ providerType }, 'Proveedor no reconocido, utilizando ElevenLabs por defecto.');
        return this.elevenLabsInstance;
    }
  }
}
