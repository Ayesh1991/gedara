#include "catalog.h"

#include <LittleFS.h>

#include "settings.h"

namespace {
SemaphoreHandle_t mtx;
String table;       // "\n<code>\t<name>\n<code>\t<name>\n…" (a leading newline makes every key "\n<code>\t")
String ver;
size_t entries = 0;
constexpr const char* kPath = "/cat.tsv";
constexpr size_t kMaxBytes = 24 * 1024;

void recount() {
  entries = 0;
  for (size_t i = 1; i < table.length(); i++) if (table[i] == '\n') entries++;
}

bool find(const String& code, char* name, size_t n) {
  const String key = String("\n") + code + "\t";
  const int at = table.indexOf(key);
  if (at < 0) return false;
  const int from = at + key.length();
  int to = table.indexOf('\n', from);
  if (to < 0) to = table.length();
  strlcpy(name, table.substring(from, to).c_str(), n);
  return true;
}
}  // namespace

void catalog::begin() {
  mtx = xSemaphoreCreateMutex();
  ver = settings::loadStr("cat_v", "");
  File f = LittleFS.open(kPath, "r");
  if (f && f.size() <= kMaxBytes) {
    table = "\n";
    table += f.readString();
  }
  if (f) f.close();
  if (table.length() < 2) {
    table = "\n";
    ver = "";  // no file: ask Gedara for the list again
  }
  recount();
}

String catalog::version() {
  xSemaphoreTake(mtx, portMAX_DELAY);
  const String v = ver;
  xSemaphoreGive(mtx);
  return v;
}

void catalog::replace(const char* version, JsonArrayConst items) {
  String next = "\n";
  next.reserve(8192);
  for (JsonArrayConst row : items) {
    const char* code = row[0] | "";
    const char* name = row[1] | "";
    if (!code[0] || strlen(code) > 96 || strchr(code, '\t') || strchr(code, '\n')) continue;
    if (next.length() + strlen(code) + 28 > kMaxBytes) break;
    next += code;
    next += '\t';
    for (size_t i = 0; name[i] && i < 24; i++) {
      const char c = name[i];
      next += (c >= 0x20 && c <= 0x7E) ? c : '?';
    }
    next += '\n';
  }
  File f = LittleFS.open(kPath, "w");
  bool ok = false;
  if (f) {
    ok = f.print(next.c_str() + 1) == next.length() - 1;
    f.close();
  }
  xSemaphoreTake(mtx, portMAX_DELAY);
  table = next;
  // Only remember the version when the file was written: otherwise Gedara sends the list again.
  ver = ok ? String(version) : String("");
  recount();
  xSemaphoreGive(mtx);
  settings::storeStr("cat_v", ver);
}

bool catalog::lookup(const char* code, char* name, size_t n) {
  if (!code || !code[0]) return false;
  xSemaphoreTake(mtx, portMAX_DELAY);
  String c(code);
  // Our own labels may come as the URL of an A4 label: …/s/HL:PRD:XXXXXX.
  const int hl = c.lastIndexOf("/s/HL:");
  if (hl >= 0) c = c.substring(hl + 3);
  if (c.startsWith("hl:") || c.startsWith("Hl:") || c.startsWith("hL:")) c.toUpperCase();
  bool ok = find(c, name, n);
  if (!ok) {
    bool digits = c.length() > 0;
    for (size_t i = 0; i < c.length(); i++) if (!isdigit(static_cast<unsigned char>(c[i]))) digits = false;
    if (digits && c.length() == 12) ok = find(String("0") + c, name, n);
    else if (digits && c.length() == 13 && c[0] == '0') ok = find(c.substring(1), name, n);
  }
  xSemaphoreGive(mtx);
  return ok;
}

size_t catalog::count() { return entries; }
