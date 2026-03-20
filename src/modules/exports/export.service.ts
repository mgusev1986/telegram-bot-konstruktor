import ExcelJS from "exceljs";
import { Prisma, type PrismaClient, type User, type UserRole } from "@prisma/client";

import type { ReferralService } from "../referrals/referral.service";

export type ExportUserRow = {
  id: string;
  telegram_user_id: bigint;
  username: string | null;
  first_name: string;
  last_name: string;
  full_name: string;
  phone: string | null;
  selected_language: string;
  role: string;
  status: string;
  level: number;
  invited_by_user_id: string | null;
  created_at: Date;
};

export interface UsersHtmlExportResult {
  buffer: Buffer;
  totalCount: number;
  exportDate: Date;
}

export interface UsersExcelExportResult {
  buffer: Buffer;
  totalCount: number;
  exportDate: Date;
}

const GROUP_ANONYMOUS_BOT = "groupanonymousbot";

function isAnonymousBotRow(row: ExportUserRow): boolean {
  const u = (row.username ?? "").trim().toLowerCase();
  const f = (row.first_name ?? "").trim().toLowerCase();
  const full = (row.full_name ?? "").trim().toLowerCase();
  return u === GROUP_ANONYMOUS_BOT || f === GROUP_ANONYMOUS_BOT || full === GROUP_ANONYMOUS_BOT;
}

const escapeHtml = (s: string): string =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Display name: username (link) > full_name > first_name > telegram id. Link only when username exists. */
function userDisplayCell(row: ExportUserRow): string {
  const telegramId = String(row.telegram_user_id);
  if (row.username?.trim()) {
    const safeUsername = escapeHtml(row.username.trim());
    return `<a href="https://t.me/${safeUsername}" target="_blank" rel="noopener">${safeUsername}</a>`;
  }
  if (row.full_name?.trim()) return escapeHtml(row.full_name.trim());
  if (row.first_name?.trim()) return escapeHtml(row.first_name.trim());
  return escapeHtml(telegramId);
}

/** Format date for caption/table (DD.MM.YYYY HH:mm:ss). */
function formatExportDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  const sec = String(d.getSeconds()).padStart(2, "0");
  return `${day}.${m}.${y} ${h}:${min}:${sec}`;
}


/** Date as YYYY-MM-DD for data-date attribute (filtering). */
function formatDateIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Searchable display name (same priority as userDisplayCell, for data-display-name). */
function searchableDisplayName(row: ExportUserRow): string {
  const s = row.username?.trim() || row.full_name?.trim() || row.first_name?.trim() || String(row.telegram_user_id);
  return s.toLowerCase();
}

export class ExportService {
  public constructor(
    private readonly prisma: PrismaClient,
    private readonly referrals: ReferralService
  ) {}

  /** Readable filename: users-export-... or structure-export-... */
  public formatExportFilename(
    extension: "html" | "xlsx",
    date: Date,
    kind: "users" | "structure" = "users"
  ): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    const h = String(date.getHours()).padStart(2, "0");
    const min = String(date.getMinutes()).padStart(2, "0");
    const sec = String(date.getSeconds()).padStart(2, "0");
    const prefix = kind === "structure" ? "structure-export" : "users-export";
    return `${prefix}-${y}-${m}-${d}-${h}-${min}-${sec}.${extension}`;
  }

  /** Caption under the file in Telegram. typeLabel e.g. "Пользователи (HTML)". */
  public formatExportCaption(totalCount: number, exportDate: Date, typeLabel?: string): string {
    const dt = formatExportDate(exportDate);
    if (typeLabel) {
      return `Выгрузка данных: ${typeLabel}\nДата: ${dt}\nВсего пользователей: ${totalCount}`;
    }
    return `Выгрузка данных на ${dt}\nВсего пользователей: ${totalCount}`;
  }

  /** Public helper for localized Telegram captions. */
  public formatExportDate(date: Date): string {
    return formatExportDate(date);
  }

  private async getExportRows(requester: User, exportRole: UserRole): Promise<ExportUserRow[]> {
    const scopedBotInstanceId = requester.botInstanceId ?? null;
    // Effective role decides export scope:
    // - OWNER => full structure (all users)
    // - ADMIN/USER => only first line (direct referrals, level 1)
    if (exportRole === "ALPHA_OWNER") {
      return this.prisma.$queryRaw<ExportUserRow[]>`
        SELECT
          id,
          telegram_user_id,
          username,
          first_name,
          last_name,
          full_name,
          phone,
          selected_language,
          role,
          status,
          0 AS level,
          invited_by_user_id,
          created_at
        FROM users
        WHERE (${scopedBotInstanceId}::text IS NULL OR bot_instance_id = ${scopedBotInstanceId})
        ORDER BY created_at ASC
      `;
    }
    return this.prisma.$queryRaw<ExportUserRow[]>`
      SELECT
        id,
        telegram_user_id,
        username,
        first_name,
        last_name,
        full_name,
        phone,
        selected_language,
        role,
        status,
        1 AS level,
        invited_by_user_id,
        created_at
      FROM users
      WHERE invited_by_user_id = ${requester.id}
        AND (${scopedBotInstanceId}::text IS NULL OR bot_instance_id = ${scopedBotInstanceId})
      ORDER BY created_at ASC
    `;
  }

  private async getInvitedCounts(userIds: string[], botInstanceId?: string | null): Promise<Map<string, number>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<Array<{ invited_by_user_id: string; count: bigint }>>`
      SELECT invited_by_user_id, COUNT(*)::int AS count
      FROM users
      WHERE invited_by_user_id IN (${Prisma.join(userIds)})
        AND (${botInstanceId ?? null}::text IS NULL OR bot_instance_id = ${botInstanceId ?? null})
      GROUP BY invited_by_user_id
    `;
    const map = new Map<string, number>();
    for (const r of rows) {
      map.set(r.invited_by_user_id, Number(r.count));
    }
    return map;
  }

  public async buildUsersHtmlReport(
    requester: User,
    opts?: { effectiveRole?: UserRole; languageCode?: string }
  ): Promise<UsersHtmlExportResult> {
    const exportRole = opts?.effectiveRole ?? requester.role;
    const isEnglish = String(opts?.languageCode ?? requester.selectedLanguage ?? "ru")
      .toLowerCase()
      .startsWith("en");
    const ui = isEnglish
      ? {
          title: "Statistics",
          exportTime: "Export time",
          totalUsers: "Total users",
          userId: "User ID",
          mentorId: "Mentor ID",
          userName: "User name",
          registrationDateFrom: "Registration date: from",
          registrationDateTo: "Registration date: to",
          datePlaceholder: "YYYY-MM-DD",
          userLanguage: "User language",
          all: "— All —",
          applyFilters: "Apply filters",
          resetFilters: "Reset filters",
          invitedCount: "Invited count",
          registrationDate: "Registration date"
        }
      : {
          title: "Статистика",
          exportTime: "Время выгрузки",
          totalUsers: "Всего пользователей",
          userId: "Айди пользователя",
          mentorId: "Айди ментора",
          userName: "Имя пользователя",
          registrationDateFrom: "Дата регистрации: от",
          registrationDateTo: "Дата регистрации: до",
          datePlaceholder: "YYYY-MM-DD",
          userLanguage: "Язык пользователя",
          all: "— Все —",
          applyFilters: "Применить фильтры",
          resetFilters: "Сбросить фильтры",
          invitedCount: "Количество приглашённых",
          registrationDate: "Дата регистрации"
        };
    const rawRows = await this.getExportRows(requester, exportRole);
    const rows = rawRows.filter((r) => !isAnonymousBotRow(r));
    const userIds = rows.map((r) => r.id);
    const invitedCounts = await this.getInvitedCounts(userIds, requester.botInstanceId);
    const exportDate = new Date();

    const languages = [...new Set(rows.map((r) => r.selected_language))].filter(Boolean).sort();
    const languageOptions = languages
      .map((lang) => `<option value="${escapeHtml(lang)}">${escapeHtml(lang)}</option>`)
      .join("");

    const tableRows = rows
      .map((row) => {
        const userId = escapeHtml(row.id);
        const mentorId = row.invited_by_user_id ? escapeHtml(row.invited_by_user_id) : "";
        const displayName = escapeHtml(searchableDisplayName(row));
        const dateIso = formatDateIso(row.created_at);
        const lang = escapeHtml(row.selected_language);
        return `
    <tr data-user-id="${userId}" data-mentor-id="${mentorId}" data-display-name="${displayName}" data-date="${dateIso}" data-language="${lang}">
      <td>${escapeHtml(row.id)}</td>
      <td>${row.invited_by_user_id ? escapeHtml(row.invited_by_user_id) : "—"}</td>
      <td>${userDisplayCell(row)}</td>
      <td>${invitedCounts.get(row.id) ?? 0}</td>
      <td>${escapeHtml(formatExportDate(row.created_at))}</td>
      <td>${escapeHtml(row.selected_language)}</td>
    </tr>`;
      })
      .join("");

    const title = ui.title;
    const exportDateTime = formatExportDate(exportDate);
    const totalCount = rows.length;

    const html = `<!DOCTYPE html>
<html lang="${isEnglish ? "en" : "ru"}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; margin: 24px; color: #222; }
    .top-block { margin-bottom: 24px; }
    .top-block h1 { font-size: 1.75rem; margin: 0 0 8px 0; font-weight: 700; }
    .top-block .meta { color: #444; font-size: 0.95rem; margin: 4px 0; }
    .filter-bar { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; margin-bottom: 20px; padding: 16px; background: #f5f5f5; border-radius: 8px; }
    .filter-bar label { display: flex; flex-direction: column; gap: 4px; font-size: 0.85rem; color: #555; }
    .filter-bar input, .filter-bar select { padding: 6px 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 0.9rem; min-width: 120px; }
    .filter-bar .btn { padding: 8px 16px; border: none; border-radius: 4px; font-size: 0.9rem; cursor: pointer; font-weight: 600; }
    .filter-bar .btn-apply { background: #2d7a3e; color: #fff; }
    .filter-bar .btn-apply:hover { background: #246b32; }
    .filter-bar .btn-reset { background: #c0392b; color: #fff; }
    .filter-bar .btn-reset:hover { background: #a93226; }
    .table-wrap { overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
    th { background: #2d7a3e; color: #fff; font-weight: 600; white-space: nowrap; }
    tbody tr:nth-child(even) { background: #f9f9f9; }
    tbody tr.hidden { display: none; }
    a { color: #0d6efd; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="top-block">
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">${escapeHtml(ui.exportTime)}: ${escapeHtml(exportDateTime)}</div>
    <div class="meta">${escapeHtml(ui.totalUsers)}: ${totalCount}</div>
  </div>
  <div class="filter-bar">
    <label>${escapeHtml(ui.userId)} <input type="text" id="f-user-id" placeholder=""></label>
    <label>${escapeHtml(ui.mentorId)} <input type="text" id="f-mentor-id" placeholder=""></label>
    <label>${escapeHtml(ui.userName)} <input type="text" id="f-name" placeholder=""></label>
    <label>${escapeHtml(ui.registrationDateFrom)} <input type="text" id="f-date-from" placeholder="${escapeHtml(ui.datePlaceholder)}" inputmode="numeric" autocomplete="off"></label>
    <label>${escapeHtml(ui.registrationDateTo)} <input type="text" id="f-date-to" placeholder="${escapeHtml(ui.datePlaceholder)}" inputmode="numeric" autocomplete="off"></label>
    <label>${escapeHtml(ui.userLanguage)} <select id="f-lang"><option value="">${escapeHtml(ui.all)}</option>${languageOptions}</select></label>
    <button type="button" class="btn btn-apply" id="btn-apply">${escapeHtml(ui.applyFilters)}</button>
    <button type="button" class="btn btn-reset" id="btn-reset">${escapeHtml(ui.resetFilters)}</button>
  </div>
  <div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th>${escapeHtml(ui.userId)}</th>
        <th>${escapeHtml(ui.mentorId)}</th>
        <th>${escapeHtml(ui.userName)}</th>
        <th>${escapeHtml(ui.invitedCount)}</th>
        <th>${escapeHtml(ui.registrationDate)}</th>
        <th>${escapeHtml(ui.userLanguage)}</th>
      </tr>
    </thead>
    <tbody>${tableRows}
    </tbody>
  </table>
  </div>
  <script>
(function() {
  var tbody = document.querySelector('tbody');
  var rows = tbody && tbody.querySelectorAll('tr') || [];
  var fUserId = document.getElementById('f-user-id');
  var fMentorId = document.getElementById('f-mentor-id');
  var fName = document.getElementById('f-name');
  var fDateFrom = document.getElementById('f-date-from');
  var fDateTo = document.getElementById('f-date-to');
  var fLang = document.getElementById('f-lang');
  function normalizeDateInput(v) {
    var s = String(v || '').trim();
    if (!s) return '';
    // Accept YYYY-MM-DD
    if (/^\\d{4}-\\d{2}-\\d{2}$/.test(s)) return s;
    // Accept DD.MM.YYYY
    var m = s.match(/^(\\d{2})\\.(\\d{2})\\.(\\d{4})$/);
    if (m) return m[3] + '-' + m[2] + '-' + m[1];
    return '';
  }
  function applyFilters() {
    var vUserId = (fUserId && fUserId.value || '').trim().toLowerCase();
    var vMentorId = (fMentorId && fMentorId.value || '').trim().toLowerCase();
    var vName = (fName && fName.value || '').trim().toLowerCase();
    var vDateFrom = normalizeDateInput(fDateFrom && fDateFrom.value || '');
    var vDateTo = normalizeDateInput(fDateTo && fDateTo.value || '');
    var vLang = fLang && fLang.value || '';
    for (var i = 0; i < rows.length; i++) {
      var tr = rows[i];
      var uid = (tr.getAttribute('data-user-id') || '').toLowerCase();
      var mid = (tr.getAttribute('data-mentor-id') || '').toLowerCase();
      var name = (tr.getAttribute('data-display-name') || '');
      var date = tr.getAttribute('data-date') || '';
      var lang = tr.getAttribute('data-language') || '';
      var ok = true;
      if (vUserId && uid.indexOf(vUserId) === -1) ok = false;
      if (ok && vMentorId && mid.indexOf(vMentorId) === -1) ok = false;
      if (ok && vName && name.indexOf(vName) === -1) ok = false;
      if (ok && vDateFrom && date < vDateFrom) ok = false;
      if (ok && vDateTo && date > vDateTo) ok = false;
      if (ok && vLang && lang !== vLang) ok = false;
      tr.classList.toggle('hidden', !ok);
    }
  }
  function resetFilters() {
    if (fUserId) fUserId.value = '';
    if (fMentorId) fMentorId.value = '';
    if (fName) fName.value = '';
    if (fDateFrom) fDateFrom.value = '';
    if (fDateTo) fDateTo.value = '';
    if (fLang) fLang.value = '';
    for (var i = 0; i < rows.length; i++) rows[i].classList.remove('hidden');
  }
  var btnApply = document.getElementById('btn-apply');
  var btnReset = document.getElementById('btn-reset');
  if (btnApply) btnApply.addEventListener('click', applyFilters);
  if (btnReset) btnReset.addEventListener('click', resetFilters);
})();
  </script>
</body>
</html>`;

    return {
      buffer: Buffer.from(html, "utf-8"),
      totalCount,
      exportDate
    };
  }

  public async buildUsersWorkbook(requester: User, opts?: { effectiveRole?: UserRole }): Promise<UsersExcelExportResult> {
    const exportRole = opts?.effectiveRole ?? requester.role;
    const rawRows = await this.getExportRows(requester, exportRole);
    const rows = rawRows.filter((r) => !isAnonymousBotRow(r));
    const exportDate = new Date();
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Users", { views: [{ state: "frozen", ySplit: 1 }] });

    const USERNAME_COL = 3;
    sheet.columns = [
      { header: "ID пользователя", key: "internal_user_id", width: 38 },
      { header: "Telegram ID", key: "telegram_user_id", width: 22 },
      { header: "Username", key: "username", width: 20 },
      { header: "Имя", key: "first_name", width: 20 },
      { header: "Фамилия", key: "last_name", width: 20 },
      { header: "Полное имя", key: "full_name", width: 24 },
      { header: "ID пригласившего", key: "inviter_id", width: 38 },
      { header: "Уровень", key: "level", width: 10 },
      { header: "Дата входа", key: "join_date", width: 24 },
      { header: "Язык", key: "selected_language", width: 18 },
      { header: "Роль", key: "role", width: 12 },
      { header: "Оплата", key: "paid_status", width: 12 },
      { header: "Телефон", key: "phone", width: 20 },
      { header: "Теги", key: "tags", width: 28 }
    ];

    for (const row of rows) {
      const userId = row.id;
      const tags = await this.prisma.userTag.findMany({
        where: { userId },
        include: { tag: true }
      });
      const activeAccess = await this.prisma.userAccessRight.findFirst({
        where: {
          userId,
          status: "ACTIVE"
        }
      });

      const usernamePlain =
        row.username?.trim() ||
        row.full_name?.trim() ||
        row.first_name?.trim() ||
        String(row.telegram_user_id);

      sheet.addRow({
        internal_user_id: row.id,
        telegram_user_id: String(row.telegram_user_id),
        username: usernamePlain,
        first_name: row.first_name,
        last_name: row.last_name,
        full_name: row.full_name,
        inviter_id: row.invited_by_user_id ?? "",
        level: row.level,
        join_date: row.created_at.toISOString(),
        selected_language: row.selected_language,
        role: row.role,
        paid_status: activeAccess ? "paid" : "unpaid",
        phone: row.phone ?? "",
        tags: tags.map((tag) => tag.tag.code).join(", ")
      });
    }

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true };

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r) continue;
      if (r.username?.trim()) {
        const rowNum = i + 2;
        const cell = sheet.getCell(rowNum, USERNAME_COL);
        cell.value = {
          text: r.username.trim(),
          hyperlink: `https://t.me/${encodeURIComponent(r.username.trim())}`
        };
      }
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return {
      buffer: Buffer.from(buffer),
      totalCount: rows.length,
      exportDate
    };
  }
}
