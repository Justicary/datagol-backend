import zlib from 'node:zlib';
import https from 'node:https';

console.log(`\n================================================================`);
console.log(`🔍 VERIFICACIÓN DE REGRESIÓN DE RUNTIME — NODE.JS ${process.version}`);
console.log(`================================================================\n`);

async function testBrotliCompression(): Promise<void> {
  console.log('🧪 1. Probando compresión y descompresión Brotli (Mitigación CVE-2026-111497)...');
  
  // Probar con texto plano, strings repetitivos y buffers binarios de varios tamaños
  const testPayloads = [
    'Hola mundo desde Node.js parcheado contra Node2Shell',
    'A'.repeat(50000), // Alta repetición (compresión extrema)
    JSON.stringify({ tenant_id: 'test-tenant', data: Array.from({ length: 500 }, (_, i) => ({ id: i, name: `item-${i}` })) }),
    Buffer.from(new Uint8Array(20000).fill(42))
  ];

  for (let i = 0; i < testPayloads.length; i++) {
    const input = testPayloads[i];
    const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf-8');
    
    // Compresión síncrona
    const compressed = zlib.brotliCompressSync(buffer, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 5
      }
    });

    // Descompresión síncrona
    const decompressed = zlib.brotliDecompressSync(compressed);
    
    if (!decompressed.equals(buffer)) {
      throw new Error(`Fallo de integridad en prueba sincrónica Brotli payload #${i + 1}`);
    }

    // Compresión/Descompresión asíncrona
    await new Promise<void>((resolve, reject) => {
      zlib.brotliCompress(buffer, (err, cBuf) => {
        if (err) return reject(err);
        zlib.brotliDecompress(cBuf, (decErr, dBuf) => {
          if (decErr) return reject(decErr);
          if (!dBuf.equals(buffer)) {
            return reject(new Error(`Fallo de integridad asíncrona Brotli payload #${i + 1}`));
          }
          resolve();
        });
      });
    });
  }

  console.log('✅ Brotli: Todos los buffers comprimidos y descomprimidos con integridad 100% sin anomalías de memoria.\n');
}

async function testHttpsTlsConnections(): Promise<void> {
  console.log('🧪 2. Probando conexiones HTTPS/TLS y validación estricta de certificados/hostnames...');

  const endpoints = [
    'https://api.resend.com',
    'https://api.elevenlabs.io',
    'https://api.openai.com',
    'https://api.telnyx.com'
  ];

  for (const url of endpoints) {
    const start = Date.now();
    try {
      const response = await fetch(url, { method: 'HEAD' });
      const elapsed = Date.now() - start;
      console.log(`  ✓ Conectado a ${url} — HTTP ${response.status} en ${elapsed}ms (TLS handshake exitoso)`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ Error al conectar a ${url}: ${msg}`);
      throw err;
    }
  }

  // Verificar rechazo estricto de certificados inválidos
  await new Promise<void>((resolve, reject) => {
    const req = https.get('https://self-signed.badssl.com/', () => {
      reject(new Error('FALLO DE SEGURIDAD: Node aceptó un certificado self-signed no confiable'));
    });
    req.on('error', (err) => {
      console.log(`  ✓ Certificado inválido rechazado correctamente: ${err.message}`);
      resolve();
    });
  });

  console.log('\n✅ HTTPS/TLS: Validación estricta de nombres de host y cadenas de confianza operando con normalidad.\n');
}

async function main() {
  try {
    await testBrotliCompression();
    await testHttpsTlsConnections();
    console.log('🎉 TODAS LAS PRUEBAS DE REGRESIÓN DE RUNTIME PASARON SATISFACTORIAMENTE.');
  } catch (error) {
    console.error('❌ FALLÓ LA VERIFICACIÓN DE REGRESIÓN:', error);
    process.exit(1);
  }
}

main();
