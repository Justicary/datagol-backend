import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

export async function elevenLabsWebhookRoutes(fastify: FastifyInstance) {
  /**
   * GET /api/elevenlabs/signed-url y GET /api/elevenlabs/inbound
   * Genera una Signed URL para inicializar la conexión WebSocket / WebRTC Inbound con ElevenLabs ConvAI
   */
  fastify.get('/api/elevenlabs/signed-url', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = (request.query || {}) as any;
      const agentId = query.agentId || process.env.ELEVENLABS_AGENT_ID;
      const apiKey = query.apiKey || process.env.ELEVENLABS_API_KEY;

      if (!apiKey || !agentId) {
        return reply.status(400).send({
          status: 'error',
          message: 'Falta configurar ELEVENLABS_API_KEY o ELEVENLABS_AGENT_ID.',
        });
      }

      const response = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentId.trim()}`,
        {
          headers: {
            'xi-api-key': apiKey.trim(),
            'Content-Type': 'application/json',
          },
        }
      );

      const data = (await response.json()) as any;

      if (!response.ok) {
        const detailObj = data.detail as any;
        const errorMsg =
          typeof detailObj === 'object' && detailObj?.message
            ? detailObj.message
            : (data.detail as string) || (data.message as string) || 'Error al solicitar Signed URL en ElevenLabs API';

        return reply.status(response.status).send({
          status: 'error',
          message: errorMsg,
          details: data,
        });
      }

      return reply.send({
        status: 'success',
        signedUrl: data.signed_url,
      });
    } catch (err: any) {
      request.log.error({ err }, 'Excepción al generar Signed URL de ElevenLabs');
      return reply.status(500).send({ status: 'error', message: err.message });
    }
  });

  fastify.get('/api/elevenlabs/inbound', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = (request.query || {}) as any;
      const agentId = query.agentId || process.env.ELEVENLABS_AGENT_ID;
      const apiKey = query.apiKey || process.env.ELEVENLABS_API_KEY;

      if (!apiKey || !agentId) {
        return reply.status(400).send({
          status: 'error',
          message: 'Falta configurar ELEVENLABS_API_KEY o ELEVENLABS_AGENT_ID.',
        });
      }

      const response = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentId.trim()}`,
        {
          headers: {
            'xi-api-key': apiKey.trim(),
            'Content-Type': 'application/json',
          },
        }
      );

      const data = (await response.json()) as any;
      return reply.send(data);
    } catch (err: any) {
      return reply.status(500).send({ status: 'error', message: err.message });
    }
  });
}

export default elevenLabsWebhookRoutes;
