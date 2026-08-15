/*
  LITUM3D - Detecta declaraciones globales (const/let/class) duplicadas
  entre scripts <script src="..."> cargados juntos en la misma vista.

  En navegadores, las declaraciones léxicas de nivel superior (const/let/class)
  de distintos <script> clásicos comparten el mismo entorno léxico global del
  documento. Si dos scripts cargados en la misma página declaran el mismo
  identificador, el segundo lanza:
    SyntaxError: Identifier 'X' has already been declared
  abortando su ejecución por completo (bug real detectado en checkout.js/cart.js).

  Uso: node scripts/check-duplicate-globals.js
*/
const fs = require('fs');
const path = require('path');

const VIEWS_DIR = path.join(__dirname, '..', 'views');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const declCache = new Map();

function getTopLevelDeclarations(jsRelPath) {
  if (declCache.has(jsRelPath)) return declCache.get(jsRelPath);

  const absPath = path.join(PUBLIC_DIR, jsRelPath);
  let names = [];
  if (fs.existsSync(absPath)) {
    const content = fs.readFileSync(absPath, 'utf8');
    const re = /^(?:const|let|class)\s+([A-Za-z_$][\w$]*)/gm;
    let m;
    while ((m = re.exec(content)) !== null) {
      names.push(m[1]);
    }
  }
  declCache.set(jsRelPath, names);
  return names;
}

function getLocalScripts(htmlContent) {
  const re = /<script[^>]+src=["']([^"']+)["']/g;
  const scripts = [];
  let m;
  while ((m = re.exec(htmlContent)) !== null) {
    const src = m[1];
    if (src.startsWith('/js/')) {
      scripts.push(src.slice(1)); // -> js/xxx.js (relative to public/)
    }
  }
  return scripts;
}

function main() {
  const files = fs.readdirSync(VIEWS_DIR).filter(f => f.endsWith('.html'));
  let failures = 0;

  for (const file of files) {
    const htmlContent = fs.readFileSync(path.join(VIEWS_DIR, file), 'utf8');
    const scripts = getLocalScripts(htmlContent);
    if (scripts.length < 2) continue;

    const seen = new Map(); // identifier -> script that declared it first

    for (const scriptPath of scripts) {
      const names = getTopLevelDeclarations(scriptPath);
      for (const name of names) {
        if (seen.has(name) && seen.get(name) !== scriptPath) {
          console.error(
            `✗ ${file}: identificador "${name}" declarado en /${seen.get(name)} y /${scriptPath} (ambos cargados en la misma página)`
          );
          failures++;
        } else {
          seen.set(name, scriptPath);
        }
      }
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} colisión(es) de declaración global encontrada(s).`);
    process.exit(1);
  }

  console.log('OK: sin declaraciones globales (const/let/class) duplicadas entre scripts cargados juntos.');
}

main();
