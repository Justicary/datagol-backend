import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import ExcelJS from 'exceljs';
import { Readable } from 'stream';
import { supabaseAdmin } from '../lib/supabase.js';

export async function uploadRoutes(fastify: FastifyInstance) {
  /**
   * POST /api/upload/excel
   * Recibe un archivo .xlsx/.csv, lo procesa en memoria de forma segura con ExcelJS
   * e inserta las filas procesadas en Supabase DB.
   */
  fastify.post('/api/upload/excel', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ status: 'error', message: 'No se subió ningún archivo.' });
      }

      // Convertir el stream a Buffer en memoria
      const buffer = await data.toBuffer();
      const filename = (data.filename || '').toLowerCase();
      const mimetype = (data.mimetype || '').toLowerCase();

      // Cargar en ExcelJS según la extensión/mimetype (.csv vs .xlsx)
      const workbook = new ExcelJS.Workbook();
      if (filename.endsWith('.csv') || mimetype.includes('csv')) {
        const stream = Readable.from(buffer);
        await workbook.csv.read(stream);
      } else {
        await workbook.xlsx.load(buffer as any);
      }

      const worksheet = workbook.getWorksheet(1);
      if (!worksheet) {
        return reply.status(400).send({ status: 'error', message: 'El archivo Excel está vacío o es inválido.' });
      }

      const rows: Record<string, any>[] = [];
      const headers: string[] = [];

      // Mapear cabeceras (Fila 1)
      const firstRow = worksheet.getRow(1);
      firstRow.eachCell((cell, colNumber) => {
        headers[colNumber] = String(cell.value || '').trim().toLowerCase();
      });

      // Procesar filas de datos
      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; // Omitir cabecera

        const rowData: Record<string, any> = {};
        row.eachCell((cell, colNumber) => {
          const header = headers[colNumber];
          if (header) {
            rowData[header] = cell.value;
          }
        });

        if (Object.keys(rowData).length > 0) {
          rows.push(rowData);
        }
      });

      console.log(`📊 Excel procesado correctamente: ${rows.length} filas extraídas.`);

      return reply.send({
        status: 'success',
        message: 'Archivo procesado e importado con éxito.',
        totalRows: rows.length,
        data: rows,
      });

    } catch (err: any) {
      console.error('❌ Error procesando Excel en backend:', err);
      return reply.status(500).send({ status: 'error', message: err.message });
    }
  });
}

export default uploadRoutes;
