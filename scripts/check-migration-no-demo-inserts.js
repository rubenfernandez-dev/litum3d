/*
  LITUM3D - Test de regresión (INCIDENT-02).

  database/migrations/add_product_variants.sql sembraba datos de ejemplo
  (Base/Forma/Madera/Plástico/Metal/Cilíndrica/Cuadrada/Hexagonal) con
  INSERT IGNORE sin ninguna UNIQUE constraint que los respalde en
  product_variant_options -- una reejecución accidental del runner de
  migraciones (ver INCIDENT-01/INCIDENT-02) creó filas duplicadas reales.
  Los INSERT se convirtieron en comentarios/documentación no ejecutable.

  Este test evita que vuelvan a colarse como SQL ejecutable: parsea el
  archivo quitando comentarios de línea y de bloque estilo C, de forma
  consciente de comillas simples (para no confundir un "--" dentro de un
  literal de texto con el inicio de un comentario), y falla si el SQL
  resultante contiene un INSERT INTO/INSERT IGNORE INTO sobre
  product_variant_types o product_variant_options.

  Uso: node scripts/check-migration-no-demo-inserts.js
*/
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const MIGRATION_PATH = path.join(__dirname, '..', 'database', 'migrations', 'add_product_variants.sql');
const FORBIDDEN_TABLES = ['product_variant_types', 'product_variant_options'];

// Quita comentarios de bloque y de línea, consciente de comillas simples,
// para no tratar un "--" dentro de un literal ('...') como comentario.
function stripSqlComments(sql) {
  const noBlockComments = sql.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const lines = noBlockComments.split(/\r?\n/);
  const cleanedLines = lines.map(line => {
    let inString = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === "'") {
        inString = !inString;
        continue;
      }
      if (!inString && ch === '-' && line[i + 1] === '-') {
        return line.slice(0, i);
      }
    }
    return line;
  });
  return cleanedLines.join('\n');
}

function findExecutableInsertsInto(sql, tableName) {
  const executable = stripSqlComments(sql);
  const re = new RegExp(`INSERT\\s+(IGNORE\\s+)?INTO\\s+${tableName}\\b`, 'i');
  return re.test(executable);
}

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks++; }

function main() {
  // --- Autotest del stripper: debe distinguir comentario de SQL real. ---
  const fixtureCommentedOut = `
    -- INSERT INTO product_variant_options (nombre) VALUES ('Madera');
    /* INSERT INTO product_variant_types (nombre) VALUES ('Base'); */
    SELECT 1;
  `;
  ok(
    !findExecutableInsertsInto(fixtureCommentedOut, 'product_variant_options'),
    'el stripper NO debe detectar un INSERT que está comentado con -- como ejecutable'
  );
  ok(
    !findExecutableInsertsInto(fixtureCommentedOut, 'product_variant_types'),
    'el stripper NO debe detectar un INSERT dentro de un comentario de bloque /* */ como ejecutable'
  );

  const fixtureExecutable = `
    INSERT IGNORE INTO product_variant_options (nombre) VALUES ('Madera');
  `;
  ok(
    findExecutableInsertsInto(fixtureExecutable, 'product_variant_options'),
    'el stripper SÍ debe detectar un INSERT ejecutable real (caso de control positivo)'
  );

  const fixtureDashInsideString = `
    INSERT INTO product_variant_options (nombre) VALUES ('Base -- no es un comentario');
  `;
  ok(
    findExecutableInsertsInto(fixtureDashInsideString, 'product_variant_options'),
    'un "--" dentro de un literal de texto NO debe cortar la sentencia SQL (falso comentario)'
  );

  // --- Comprobación real sobre el archivo de migración ---
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  for (const table of FORBIDDEN_TABLES) {
    ok(
      !findExecutableInsertsInto(sql, table),
      `database/migrations/add_product_variants.sql NO debe contener un INSERT ejecutable sobre ${table} (datos de ejemplo deben quedar solo como comentario/documentación)`
    );
  }

  console.log(`OK: ${checks} comprobaciones sobre ausencia de INSERT de demo ejecutables en add_product_variants.sql.`);
}

main();
