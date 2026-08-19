/*
  LITUM3D - Retirada comercial de la forma Cuadrada (informe de retirada,
  sección 10).

  La decisión comercial es: Cuadrada deja de ofrecerse para NUEVAS
  personalizaciones; Cilíndrica/Cónica/Esférica siguen intactas; nada se
  hardcodea por nombre en el frontend (Admin configura -> API expone ->
  Home/Shop representan). El mecanismo canónico ya existente es
  activo=FALSE sobre product_variant_options/product_variant_types,
  filtrado por routes/variantes.js (ver GET /variant-types) y escrito por
  el propio DELETE /api/variant-options/:optionId (soft-delete real, sin
  DROP ni borrado físico).

  Este script NO toca la base de datos real (.env): igual que
  scripts/check-catalog-auth.js, invoca las funciones handler REALES de
  routes/variantes.js/routes/admin.js con un req/res simulados y un pool
  falso en memoria -- así se ejercita el mismo SQL que corre en producción
  sin necesidad de MySQL. Los ids de producto/tipo/opción se generan en
  tiempo de ejecución (contador), nunca hardcodeados.

  Uso: node scripts/check-square-shape-retirement.js
*/
const assert = require('assert');
const fs = require('fs');
const path = require('path');

function readFile(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

let checks = 0;
function check(condition, message) {
  checks++;
  assert.ok(condition, message);
}

// ================= Fake pool: mismo SQL real, datos en memoria =================
// Reproduce el comportamiento de MySQL para las cláusulas WHERE que usa
// routes/variantes.js/routes/admin.js: si la sentencia normalizada
// contiene "activo = TRUE" o "activo=TRUE", filtra por activo=1 -- si la
// quitaran del código real, este fake dejaría de filtrar y las
// comprobaciones de "Cuadrada no debe aparecer" fallarían solas.
function makeFakePool(initialTypes, initialOptions) {
  const types = initialTypes.map(t => ({ ...t }));
  const options = initialOptions.map(o => ({ ...o }));
  const executedQueries = [];

  async function query(sql, params = []) {
    const norm = sql.replace(/\s+/g, ' ').trim();
    executedQueries.push({ sql: norm, params });

    if (/SELECT[\s\S]*FROM product_variant_types/i.test(norm) && /WHERE product_id = \?/i.test(norm)) {
      const [productId] = params;
      let rows = types.filter(t => String(t.product_id) === String(productId));
      if (/activo\s*=\s*TRUE/i.test(norm)) rows = rows.filter(t => t.activo === 1);
      return [rows.map(({ product_id, ...rest }) => ({ ...rest }))];
    }

    if (/SELECT[\s\S]*FROM product_variant_options/i.test(norm) && /WHERE variant_type_id = \?/i.test(norm)) {
      const [typeId] = params;
      let rows = options.filter(o => String(o.variant_type_id) === String(typeId));
      if (/activo\s*=\s*TRUE/i.test(norm)) rows = rows.filter(o => o.activo === 1);
      return [rows.map(({ variant_type_id, ...rest }) => ({ ...rest }))];
    }

    if (/UPDATE product_variant_options SET activo = FALSE WHERE id = \?/i.test(norm)) {
      const [id] = params;
      const row = options.find(o => String(o.id) === String(id));
      if (!row) return [{ affectedRows: 0 }];
      row.activo = 0;
      return [{ affectedRows: 1 }];
    }

    throw new Error(`Fake pool: consulta no reconocida en el fixture -- ${norm}`);
  }

  return { query, types, options, executedQueries };
}

// Extrae el handler real de un router Express (mismo patrón que
// scripts/check-catalog-auth.js): la última función en route.stack es
// siempre la lógica de negocio, tras requireAuth/csrfProtection si los
// hay.
function getRouteHandler(router, method, routePath) {
  const layer = router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`Ruta no encontrada: ${method.toUpperCase()} ${routePath}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; }
  };
  return res;
}

async function main() {
  const variantesRouter = require('../routes/variantes');
  const getVariantTypes = getRouteHandler(variantesRouter, 'get', '/api/productos/:productId/variant-types');
  const deleteVariantOption = getRouteHandler(variantesRouter, 'delete', '/api/variant-options/:optionId');

  // Reemplaza el pool real que routes/variantes.js capturó vía
  // `const { pool } = require('../config/db')` -- misma referencia de
  // objeto, así que sustituir sus métodos aquí basta sin volver a
  // requerir el router.
  const dbConfig = require('../config/db');

  // ================= Fixture dinámico: 1 producto, 1 tipo "Forma", 4 opciones =================
  // Ids generados en runtime (Date.now()-based), nunca constantes de un
  // producto real -- sección 10: "usa configuración dinámica, no
  // hardcodees IDs concretos de productos".
  const base = Date.now() % 1000000;
  const PRODUCT_ID = base + 1;
  const TYPE_ID = base + 2;
  const OPT_CILINDRICA = base + 3;
  const OPT_CONICA = base + 4;
  const OPT_ESFERICA = base + 5;
  const OPT_CUADRADA = base + 6;

  const typesFixture = [
    { id: TYPE_ID, product_id: PRODUCT_ID, nombre: 'Forma', descripcion: 'Forma del producto', is_required: 1, display_order: 1, activo: 1 }
  ];
  const optionsFixture = [
    { id: OPT_CILINDRICA, variant_type_id: TYPE_ID, nombre: 'Cilíndrica', descripcion: null, price_delta: '0.00', stock: 25, imagen: null, sku: null, display_order: 1, activo: 1 },
    { id: OPT_CONICA, variant_type_id: TYPE_ID, nombre: 'Cónica', descripcion: null, price_delta: '2.50', stock: 18, imagen: null, sku: null, display_order: 2, activo: 1 },
    { id: OPT_ESFERICA, variant_type_id: TYPE_ID, nombre: 'Esférica', descripcion: null, price_delta: '4.00', stock: 12, imagen: null, sku: null, display_order: 3, activo: 1 },
    { id: OPT_CUADRADA, variant_type_id: TYPE_ID, nombre: 'Cuadrada', descripcion: 'Forma cuadrada moderna', price_delta: '3.00', stock: 20, imagen: null, sku: null, display_order: 4, activo: 1 }
  ];

  const fakePool = makeFakePool(typesFixture, optionsFixture);
  dbConfig.pool.query = fakePool.query;

  // --- 1/2/3: Cilíndrica/Cónica/Esférica activas -> aparecen ---
  {
    const req = { params: { productId: String(PRODUCT_ID) } };
    const res = makeRes();
    await getVariantTypes(req, res);
    const formaType = res.body.find(t => t.nombre === 'Forma');
    check(!!formaType, 'GET /variant-types devuelve el tipo "Forma" del producto de fixture');
    const names = formaType.options.map(o => o.nombre);
    check(names.includes('Cilíndrica'), 'Cilíndrica (activa) aparece en /variant-types');
    check(names.includes('Cónica'), 'Cónica (activa) aparece en /variant-types');
    check(names.includes('Esférica'), 'Esférica (activa) aparece en /variant-types');

    // --- 7: ids y price_delta se mantienen intactos (aún con las 4 opciones activas) ---
    const byName = Object.fromEntries(formaType.options.map(o => [o.nombre, o]));
    check(byName['Cilíndrica'].id === OPT_CILINDRICA && byName['Cilíndrica'].price_delta === '0.00', 'Cilíndrica conserva su id y price_delta de fixture');
    check(byName['Cónica'].id === OPT_CONICA && byName['Cónica'].price_delta === '2.50', 'Cónica conserva su id y price_delta de fixture');
    check(byName['Esférica'].id === OPT_ESFERICA && byName['Esférica'].price_delta === '4.00', 'Esférica conserva su id y price_delta de fixture');
  }

  // --- 4: con Cuadrada aún activa, SÍ aparece (control negativo del test 6) ---
  {
    const req = { params: { productId: String(PRODUCT_ID) } };
    const res = makeRes();
    await getVariantTypes(req, res);
    const formaType = res.body.find(t => t.nombre === 'Forma');
    check(formaType.options.some(o => o.nombre === 'Cuadrada'), 'Control: con activo=1, Cuadrada SÍ aparece todavía (para que el test 6 demuestre una transición real)');
  }

  // --- 6: retirada por configuración/API -- el mismo endpoint DELETE que
  // usaría Admin (soft-delete real, activo=FALSE) hace desaparecer
  // Cuadrada del MISMO producto sin ningún cambio de código/deploy ---
  {
    const deleteReq = { params: { optionId: String(OPT_CUADRADA) } };
    const deleteRes = makeRes();
    await deleteVariantOption(deleteReq, deleteRes);
    check(deleteRes.statusCode === 200 && deleteRes.body?.ok === true, 'DELETE /api/variant-options/:id (soft-delete) responde ok:true');
    check(fakePool.options.find(o => o.id === OPT_CUADRADA).activo === 0, 'DELETE deja activo=0 en la fila, no la borra físicamente (soft-delete real)');

    const req = { params: { productId: String(PRODUCT_ID) } };
    const res = makeRes();
    await getVariantTypes(req, res);
    const formaType = res.body.find(t => t.nombre === 'Forma');
    const names = formaType.options.map(o => o.nombre);
    check(!names.includes('Cuadrada'), 'Tras la desactivación por API, Cuadrada NO aparece en /variant-types (mecanismo canónico, sin condición hardcodeada en frontend)');

    // --- 7 (repetido tras la desactivación): las demás variantes no se mueven ---
    const byName = Object.fromEntries(formaType.options.map(o => [o.nombre, o]));
    check(byName['Cilíndrica'].id === OPT_CILINDRICA && byName['Cilíndrica'].price_delta === '0.00', 'Tras desactivar Cuadrada, Cilíndrica conserva id y price_delta');
    check(byName['Cónica'].id === OPT_CONICA && byName['Cónica'].price_delta === '2.50', 'Tras desactivar Cuadrada, Cónica conserva id y price_delta');
    check(byName['Esférica'].id === OPT_ESFERICA && byName['Esférica'].price_delta === '4.00', 'Tras desactivar Cuadrada, Esférica conserva id y price_delta');

    // --- 10: la desactivación solo tocó product_variant_options; ninguna
    // consulta del fixture fue contra pedidos/detalle_pedidos/checkout_drafts ---
    const touchedOrderTables = fakePool.executedQueries.some(q => /\b(pedidos|detalle_pedidos|checkout_drafts)\b/i.test(q.sql));
    check(!touchedOrderTables, 'Desactivar Cuadrada no ejecuta ninguna consulta sobre pedidos/detalle_pedidos/checkout_drafts (datos históricos no se tocan)');
  }

  // ================= 5: sin condición hardcodeada por nombre "Cuadrada" =================
  // Arquitectura Admin configura -> API expone -> Home/Shop representan:
  // customization.js renderiza var.options tal cual vienen de /variant-types,
  // sin comparar nombre contra 'Cuadrada' en ningún punto (ver openCustomization/
  // loadModelsForProduct/loadVariantTypes). Se busca el LITERAL de cadena
  // "Cuadrada" (comillas incluidas) -- una condición hardcodeada
  // necesariamente lo usaría así (p.ej. nombre === 'Cuadrada'); el propio
  // código sí puede mencionar la palabra en comentarios explicando esta
  // misma retirada (ver cabecera de customization.js, sección 1), y eso NO
  // es una exclusión hardcodeada.
  {
    const QUOTED_CUADRADA = /['"]\s*cuadrada\s*['"]/i;
    const src = readFile('public/js/customization.js');
    check(!QUOTED_CUADRADA.test(src), 'customization.js no contiene el literal de cadena "Cuadrada" (sin comparación/exclusión hardcodeada por nombre)');
    const shopSrc = readFile('public/js/shop.js');
    const homeSrc = readFile('public/js/home.js');
    check(!QUOTED_CUADRADA.test(shopSrc), 'shop.js no contiene el literal de cadena "Cuadrada"');
    check(!QUOTED_CUADRADA.test(homeSrc), 'home.js no contiene el literal de cadena "Cuadrada"');
  }

  // ================= 8: el límite de fotos sigue siendo 3 (no se ha tocado) =================
  {
    const src = readFile('public/js/customization.js');
    check(/const\s+MAX_CUSTOMIZATION_PHOTOS\s*=\s*3\s*;/.test(src), 'MAX_CUSTOMIZATION_PHOTOS sigue siendo 3 tras la retirada de Cuadrada (regla comercial sin cambios)');
  }

  // ================= 9: las vistas públicas ya no describen la Cuadrada retirada =================
  // Solo el contenido que describía la Cuadrada (icono 📦 + "4 fotos/photos/
  // Fotos... cubo/cube/Würfel") debía desaparecer -- el resto del bloque
  // informativo (Cilíndrica/Cónica) se deja intacto, sin marketing nuevo.
  {
    const PUBLIC_VIEWS = ['views/shop.html', 'views/shop-fr.html', 'views/shop-de.html', 'views/index.html', 'views/index-fr.html', 'views/index-de.html', 'views/about.html', 'views/about-fr.html', 'views/about-de.html'];
    for (const view of PUBLIC_VIEWS) {
      const html = readFile(view);
      check(!/Litofan[ií]as Cuadradas|Lithophanies carr[ée]es|Quadratische Lithophane/i.test(html), `${view}: no queda el título de marketing de la forma Cuadrada retirada`);
      check(!/cara del cubo|face du cube|Seite des W[üu]rfels/i.test(html), `${view}: no queda la descripción "una cara del cubo"/"face du cube"/"Seite des Würfels" de la Cuadrada retirada`);
    }
    // Las cards de Cilíndrica/Cónica sobreviven intactas en las 3 vistas de shop (no se reescribió toda la página).
    check(/Cil[íi]ndricas\/C[óo]nicas/i.test(readFile('views/shop.html')), 'views/shop.html conserva la card informativa de Cilíndrica/Cónica');
    check(/cylindriques\/coniques/i.test(readFile('views/shop-fr.html')), 'views/shop-fr.html conserva la card informativa de Cilíndrica/Cónica');
    check(/[Zz]ylindrische\/konische/i.test(readFile('views/shop-de.html')), 'views/shop-de.html conserva la card informativa de Cilíndrica/Cónica');
  }

  // ================= 10: el detalle de pedido de Admin no depende de activo =================
  // routes/admin.js#/pedidos/:id/detalle es la vista real que usa
  // admin-dashboard.html. Comprobación de fuente: su SQL no filtra ni hace
  // JOIN contra product_variant_options/product_variant_types, así que
  // desactivar una opción (activo=FALSE) no puede alterar lo que un pedido
  // antiguo muestra en Admin -- no hay nada ahí que dependa de activo.
  {
    const adminSrc = readFile('routes/admin.js');
    const detalleRouteMatch = adminSrc.match(/router\.get\('\/pedidos\/:id\/detalle'[\s\S]*?\n\}\);/);
    check(!!detalleRouteMatch, 'routes/admin.js define GET /pedidos/:id/detalle (vista real de Admin)');
    const detalleSrc = detalleRouteMatch[0];
    check(!/product_variant_options|product_variant_types/i.test(detalleSrc), 'GET /pedidos/:id/detalle no consulta product_variant_options/product_variant_types (no puede verse afectado por activo=FALSE)');
  }

  // ================= Migraciones: ninguna reintroduce Cuadrada al recrear el entorno =================
  {
    const simpleMigration = readFile('database/migrations/add_product_variants_simple.sql');
    const withoutBlockComments = simpleMigration.replace(/\/\*[\s\S]*?\*\//g, ' ');
    const executable = withoutBlockComments.split(/\r?\n/).map(l => l.replace(/--.*$/, '')).join('\n');
    check(!/INSERT[\s\S]{0,200}Cuadrada/i.test(executable), 'add_product_variants_simple.sql no contiene un INSERT ejecutable que siembre "Cuadrada" (no debe resucitar al recrear el entorno)');
  }

  console.log(`OK: ${checks} comprobaciones sobre la retirada comercial de la forma Cuadrada.`);
}

main().catch(err => {
  console.error('FALLO en check-square-shape-retirement.js:', err.message);
  process.exit(1);
});
