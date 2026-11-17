// @ts-nocheck — СГЕНЕРИРОВАНО scripts/sync-name-translit.mjs из booking-platform/src/domain/rules/tests/name-translit.test.ts; руками не править.
// Типы проверяет tsc сайта (noUncheckedIndexedAccess у сайта выключен, у сервера включён — отсюда nocheck).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { localizedName, nameScript, translitName } from './translit.js';

// Имя мастера на трёх языках (владелец 17.11.2026, DESIGN.md «Ответы…» №8): вписали на одном — остальные переводом букв
describe('translitName: частые армянские имена', () => {
  const cases: [ru: string, hy: string, en: string][] = [
    ['Ани', 'Անի', 'Ani'],
    ['Арам', 'Արամ', 'Aram'],
    ['Гаяне', 'Գայանե', 'Gayane'],
    ['Саргсян', 'Սարգսյան', 'Sargsyan'],
    ['Мелкумян', 'Մելքումյան', 'Melkumyan'],
    ['Тигран', 'Տիգրան', 'Tigran'],
    ['Ануш', 'Անուշ', 'Anush'],
  ];
  for (const [ru, hy, en] of cases) {
    test(`${ru} ↔ ${hy} ↔ ${en}`, () => {
      assert.equal(translitName(ru, 'hy'), hy);
      assert.equal(translitName(ru, 'en'), en);
      assert.equal(translitName(hy, 'ru'), ru);
      assert.equal(translitName(hy, 'en'), en);
      assert.equal(translitName(en, 'ru'), ru);
      assert.equal(translitName(en, 'hy'), hy);
    });
  }
  test('имя и фамилия вместе', () => {
    assert.equal(translitName('Ани Саргсян', 'hy'), 'Անի Սարգսյան');
    assert.equal(translitName('Ани Саргсян', 'en'), 'Ani Sargsyan');
    assert.equal(translitName('Անի Մելքումյան', 'ru'), 'Ани Мелкумян');
    assert.equal(translitName('Ani Sargsyan', 'ru'), 'Ани Саргсян');
  });
});

describe('translitName: правила по буквам (слов нет в словаре)', () => {
  test('ru → hy', () => {
    assert.equal(translitName('Ирина', 'hy'), 'Իրինա');
    assert.equal(translitName('Татьяна', 'hy'), 'Տատյանա');
    assert.equal(translitName('Мария', 'hy'), 'Մարիա');
    assert.equal(translitName('Ереван', 'hy'), 'Երևան');
    assert.equal(translitName('Хачик Мкртумян', 'hy'), 'Խաչիկ Մկրտումյան');
    assert.equal(translitName('Ольга', 'hy'), 'Օլգա');
  });
  test('hy → ru', () => {
    assert.equal(translitName('Սյուզի', 'ru'), 'Сюзи');
    assert.equal(translitName('Մհեր', 'ru'), 'Мгер');
    assert.equal(translitName('Սահակ', 'ru'), 'Саак');
    assert.equal(translitName('Ոսկի', 'ru'), 'Воски');
  });
  test('en → hy и ru', () => {
    assert.equal(translitName('Yeranuhi', 'hy'), 'Երանուհի');
    assert.equal(translitName('Sevak', 'hy'), 'Սևակ');
    assert.equal(translitName('Sevak', 'ru'), 'Севак');
  });
  test('регистр, дефис и прочее — как есть', () => {
    assert.equal(translitName('Анна-Мария', 'hy'), 'Աննա-Մարիա');
    assert.equal(translitName('ани', 'hy'), 'Անի');
    assert.equal(translitName('Studio 5', 'ru'), 'Студио 5');
    assert.equal(translitName('', 'hy'), '');
  });
});

describe('nameScript и localizedName', () => {
  test('письмо имени', () => {
    assert.equal(nameScript('Ани'), 'ru');
    assert.equal(nameScript('Անի'), 'hy');
    assert.equal(nameScript('Ani'), 'en');
    assert.equal(nameScript('123'), undefined);
  });
  test('вписанный перевод важнее перевода букв, пустой — перевод на лету', () => {
    assert.equal(localizedName('Ани Саргсян', { hy: 'Անի Սարգսյան-Ղազարյան' }, 'hy'), 'Անի Սարգսյան-Ղազարյան');
    assert.equal(localizedName('Ани Саргсян', { hy: '  ' }, 'hy'), 'Անի Սարգսյան');
    assert.equal(localizedName('Ани Саргсян', undefined, 'en'), 'Ani Sargsyan');
    assert.equal(localizedName('Ани Саргсян', undefined, 'ru'), 'Ани Саргсян');
    assert.equal(localizedName(undefined, undefined, 'ru'), '');
  });
});
