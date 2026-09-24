import type { SupabaseClient } from '@supabase/supabase-js';
import { REPORTS_BUCKET } from './report-storage-service.js';

/**
 * Parte del "restaurar valores de fábrica" que vive FUERA de Postgres: los
 * archivos de `weekly_reports` en el bucket `organization-reports`
 * (db/migrations/74_factory_reset_extended.sql vacía las filas, pero Storage
 * no participa de la transacción).
 *
 * Orden en la ruta: primero se leen las rutas, luego corre la función SQL y
 * SOLO si tuvo éxito se borran los archivos. Al revés, un fallo de la
 * función dejaría filas de reportes apuntando a archivos ya borrados.
 */

/** Filas leídas por página y archivos por llamada a `storage.remove()`. */
export const REPORT_PATHS_PAGE_SIZE = 1000;
export const STORAGE_REMOVE_BATCH_SIZE = 100;

/**
 * Rutas de Storage de todos los reportes semanales (de todas las
 * organizaciones: el factory reset no es por tenant). Lanza si la lectura
 * falla — sin la lista, borrar las filas dejaría archivos huérfanos sin
 * forma de ubicarlos.
 */
export async function collectReportStoragePaths(supabase: SupabaseClient): Promise<string[]> {
    const paths: string[] = [];
    for (let from = 0; ; from += REPORT_PATHS_PAGE_SIZE) {
        const { data, error } = await supabase
            .from('weekly_reports')
            .select('storage_path')
            .not('storage_path', 'is', null)
            .order('id')
            .range(from, from + REPORT_PATHS_PAGE_SIZE - 1)
            .returns<Array<{ storage_path: string }>>();
        if (error) throw new Error(`No se pudieron leer las rutas de weekly_reports: ${error.message}`);
        const rows = data ?? [];
        for (const row of rows) paths.push(row.storage_path);
        if (rows.length < REPORT_PATHS_PAGE_SIZE) return paths;
    }
}

export interface ReportFilesRemoval {
    removed: number;
    failed: number;
    errors: string[];
}

/**
 * Borra los archivos por lotes. Nunca lanza: las filas ya se borraron, así
 * que un fallo aquí solo deja archivos huérfanos, que se reportan para
 * limpiarlos a mano en vez de ocultarse.
 */
export async function removeReportFiles(supabase: SupabaseClient, paths: string[]): Promise<ReportFilesRemoval> {
    const result: ReportFilesRemoval = { removed: 0, failed: 0, errors: [] };
    for (let i = 0; i < paths.length; i += STORAGE_REMOVE_BATCH_SIZE) {
        const batch = paths.slice(i, i + STORAGE_REMOVE_BATCH_SIZE);
        try {
            const { data, error } = await supabase.storage.from(REPORTS_BUCKET).remove(batch);
            if (error) {
                result.failed += batch.length;
                result.errors.push(error.message);
            } else {
                // Storage devuelve solo los objetos que existían; los ya
                // inexistentes no son un fallo.
                result.removed += data?.length ?? 0;
            }
        } catch (err) {
            result.failed += batch.length;
            result.errors.push(err instanceof Error ? err.message : String(err));
        }
    }
    return result;
}
