import { parseExcelDownload } from '../excel/parse-workbook.js';
import { saveReportSheetToSupabase } from '../supabase/report-store.js';
import { logger } from '../utils/logger.js';

export async function saveDownloadedExcelToSupabase(download, {
  brand = 'kia',
  sheetName
}) {
  logger.info('Parsing downloaded Excel report in memory', {
    suggestedFilename: download.suggestedFilename()
  });

  try {
    const parsed = await parseExcelDownload(download);
    logger.info('Excel report parsed', {
      workbookSheetName: parsed.workbookSheetName,
      headerCount: parsed.headers.length,
      rowCount: parsed.rows.length
    });

    const dbResult = await saveReportSheetToSupabase({
      brand,
      sheetName,
      headers: parsed.headers,
      rows: parsed.rows
    });

    return {
      ...dbResult,
      workbookSheetName: parsed.workbookSheetName,
      headerCount: parsed.headers.length,
      rowCount: parsed.rows.length
    };
  } finally {
    await download.delete().catch(() => {});
  }
}
