'use strict';
const assert = require('assert');
const i18n = require('../src/i18n');

assert.strictEqual(i18n.resolve('auto', 'es-CO'), 'es');
assert.strictEqual(i18n.resolve('auto', 'en-US'), 'en');
assert.strictEqual(i18n.resolve('auto', 'fr-FR'), 'en');
assert.strictEqual(i18n.resolve('es', 'en-US'), 'es');

i18n.setLanguage('en');
assert.strictEqual(i18n.L('Back'), 'Back');                        // English is a no-op
assert.strictEqual(i18n.payload().dict, null);

i18n.setLanguage('es');
const L = i18n.L;
assert.strictEqual(L('Back'), 'Atrás');
assert.strictEqual(L('  Match case'), '  Distinguir mayúsculas');  // whitespace preserved
assert.strictEqual(L('✓ Invert page colors'), '✓ Invertir colores de la página');
assert.strictEqual(L('Something not in the table'), 'Something not in the table');
assert.strictEqual(L('Lord of the Rings'), 'Lord of the Rings');   // user content is never caught by a pattern
assert.strictEqual(L('12 requests blocked on this page.'), '12 solicitudes bloqueadas en esta página.');
assert.strictEqual(L('4.2 MB of 10 MB (42%) · Paused · 1.2 MB/s'), '4.2 MB de 10 MB (42%) · En pausa · 1.2 MB/s');
assert.strictEqual(L('Search Google for “hola”'), 'Buscar «hola» en Google');
assert.strictEqual(L('example.com wants to ' + L('know your location')), 'example.com quiere conocer tu ubicación');
assert.ok(Array.isArray(i18n.payload().pats) && i18n.payload().pats.every(p => { new RegExp(p[0]); return true; }));
console.log('i18n ok');
