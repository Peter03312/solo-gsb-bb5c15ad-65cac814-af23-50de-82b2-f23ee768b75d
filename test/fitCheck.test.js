'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeImposition } = require('../src/imposition');

const BASE = { totalPages: 8, sheetsPerSignature: 2, binding: 'left', flip: 'short' };

/** 收集拼版结果中的全部页位（每张纸正反 × 左右）。 */
function allSlots(r) {
  const slots = [];
  r.signatures.forEach((sig) => {
    sig.sheets.forEach((sheet) => {
      slots.push(sheet.front.left, sheet.front.right, sheet.back.left, sheet.back.right);
    });
  });
  return slots;
}

test('未提供尺寸：fit.enabled=false，页位不带 fit 字段（向后兼容）', () => {
  const r = computeImposition(BASE);
  assert.equal(r.fit.enabled, false);
  assert.equal(r.input.paperWidth, 0);
  assert.equal(r.input.bleedMm, 0);
  allSlots(r).forEach((s) => assert.equal(s.fit, undefined));
});

test('全部适配：440×310 纸张放 210×297 成品页，出血 3mm、安全边距 5mm', () => {
  const r = computeImposition({
    ...BASE,
    paperWidth: 440, paperHeight: 310, pageWidth: 210, pageHeight: 297, bleedMm: 3, safetyMm: 5,
  });
  assert.equal(r.fit.enabled, true);
  assert.equal(r.fit.ok, true);
  assert.equal(r.fit.failCount, 0);
  assert.equal(r.fit.totalSlots, 8);
  assert.equal(r.fit.slotWidth, 220);
  assert.equal(r.fit.slotHeight, 310);
  allSlots(r).forEach((s) => {
    assert.equal(s.fit.ok, true);
    assert.deepEqual(s.fit.violations, []);
  });
  // 左页位：rect / trim / bleedBox / safeBox 数值（trim 居中于页位）
  const left = r.signatures[0].sheets[0].front.left.fit;
  assert.deepEqual(left.rect, { x: 0, y: 0, width: 220, height: 310 });
  assert.deepEqual(left.trim, { x: 5, y: 6.5, width: 210, height: 297 });
  assert.deepEqual(left.bleedBox, { x: 2, y: 3.5, width: 216, height: 303 });
  assert.deepEqual(left.safeBox, { x: 10, y: 11.5, width: 200, height: 287 });
  // 右页位：可用矩形从纸张中线起算
  const right = r.signatures[0].sheets[0].front.right.fit;
  assert.deepEqual(right.rect, { x: 220, y: 0, width: 220, height: 310 });
  assert.deepEqual(right.trim, { x: 225, y: 6.5, width: 210, height: 297 });
});

test('成品页超过页位：报 page-too-wide / page-too-tall，并连带出血超界', () => {
  const r = computeImposition({ ...BASE, paperWidth: 420, paperHeight: 297, pageWidth: 215, pageHeight: 300 });
  assert.equal(r.fit.ok, false);
  const f = r.signatures[0].sheets[0].front.left.fit;
  const codes = f.violations.map((v) => v.code);
  assert.ok(codes.includes('page-too-wide'));
  assert.ok(codes.includes('page-too-tall'));
  // 页位 210×297 放不下 215×300，居中后 trim 四边均溢出页位 -> 出血框（bleed=0）超出纸张
  assert.ok(codes.includes('bleed-overflow-left'));
  assert.ok(codes.includes('bleed-overflow-top'));
  // 裁切框同样越出所属页位（居中后左右各 2.5mm、上下各 1.5mm）
  assert.ok(codes.includes('trim-overflow-left'));
  assert.ok(codes.includes('trim-overflow-right'));
  assert.ok(codes.includes('trim-overflow-top'));
  assert.ok(codes.includes('trim-overflow-bottom'));
  assert.match(f.violations.find((v) => v.code === 'trim-overflow-left').message, /越出所属页位 2.5mm/);
  // 超限原因带具体超出量
  assert.match(f.violations.find((v) => v.code === 'page-too-wide').message, /215mm 超过页位可用宽 210mm/);
});

test('出血超出纸张：左页位超左 / 上 / 下，折线侧（右）不视为超限', () => {
  const r = computeImposition({ ...BASE, paperWidth: 420, paperHeight: 297, pageWidth: 210, pageHeight: 297, bleedMm: 3 });
  const left = r.signatures[0].sheets[0].front.left.fit;
  const codes = left.violations.map((v) => v.code);
  assert.ok(codes.includes('bleed-overflow-left'));
  assert.ok(codes.includes('bleed-overflow-top'));
  assert.ok(codes.includes('bleed-overflow-bottom'));
  // 折线一侧的出血进入相邻页位属正常工艺，不构成超限
  assert.ok(!codes.includes('bleed-overflow-right'));
  // 右页位镜像：超右侧
  const right = r.signatures[0].sheets[0].front.right.fit;
  assert.ok(right.violations.map((v) => v.code).includes('bleed-overflow-right'));
  assert.ok(!right.violations.map((v) => v.code).includes('bleed-overflow-left'));
  // 具体超出量：页位 210 宽正好等于页宽，出血 3mm 全部悬在纸外
  assert.match(left.violations.find((v) => v.code === 'bleed-overflow-left').message, /超出纸张 3mm/);
});

test('爬移偏移把出血推出纸张（右装订第 2 张左页位 offset=-1）', () => {
  // 432×303 纸张：页位 216×303，trim 居中后出血框正好贴边；右装订左页位爬移 -1mm -> 超左 1mm
  const r = computeImposition({
    ...BASE,
    binding: 'right',
    paperWidth: 432, paperHeight: 303, pageWidth: 210, pageHeight: 297,
    bleedMm: 3, paperThickness: 0.5, maxCompensation: 5,
  });
  assert.deepEqual(r.creep.sheetCompensationMm, [0, 1]);
  const sheet2 = r.signatures[0].sheets[1];
  assert.equal(sheet2.front.left.offsetMm, -1);
  const v = sheet2.front.left.fit.violations.find((x) => x.code === 'bleed-overflow-left');
  assert.ok(v);
  assert.match(v.message, /超出纸张 1mm/);
  // 第 1 张（creep=0）出血框贴边但未超出
  assert.equal(r.signatures[0].sheets[0].front.left.fit.ok, true);
});

test('爬移把裁切框推出所属页位但仍在整张纸内：判不适配，给出方向与超出量并计入汇总', () => {
  // 440×310 纸张：页位 220×310，210×297 成品页居中后左右各留 5mm；
  // 第 2 张爬移 6mm（左装订左页位 +6）：裁切框右缘 221 越出页位 1mm，但出血框（右缘 224）仍在整张纸内
  const r = computeImposition({
    ...BASE,
    paperWidth: 440, paperHeight: 310, pageWidth: 210, pageHeight: 297,
    bleedMm: 3, paperThickness: 3, maxCompensation: 10,
  });
  assert.deepEqual(r.creep.sheetCompensationMm, [0, 6]);
  const sheet2 = r.signatures[0].sheets[1];
  assert.equal(sheet2.front.left.offsetMm, 6);
  const f = sheet2.front.left.fit;
  assert.equal(f.ok, false);
  assert.deepEqual(f.trim, { x: 11, y: 6.5, width: 210, height: 297 });
  const v = f.violations.find((x) => x.code === 'trim-overflow-right');
  assert.ok(v);
  assert.match(v.message, /裁切框右侧越出所属页位 1mm/);
  assert.match(v.message, /含爬移偏移 6mm/);
  // 出血框仍完全落在整张纸内：不再报出血超限，超限仅来自裁切框越出页位
  assert.deepEqual(f.violations.map((x) => x.code), ['trim-overflow-right']);
  // 右页位镜像：裁切框左侧越出页位 1mm；背面页位同样检查
  assert.ok(sheet2.front.right.fit.violations.some((x) => x.code === 'trim-overflow-left'));
  assert.ok(sheet2.back.left.fit.violations.some((x) => x.code === 'trim-overflow-right'));
  assert.ok(sheet2.back.right.fit.violations.some((x) => x.code === 'trim-overflow-left'));
  // 第 1 张（creep=0）不受影响
  assert.equal(r.signatures[0].sheets[0].front.left.fit.ok, true);
  // 计入顶层不适配汇总：第 2 张 4 个页位全部不适配
  assert.equal(r.fit.ok, false);
  assert.equal(r.fit.totalSlots, 8);
  assert.equal(r.fit.failCount, 4);
});

test('裁切框恰好贴合页位边界视为可印', () => {
  // 页宽 = 页位宽、页高 = 纸高：裁切框四边与页位边界重合（无爬移）
  const exact = computeImposition({ ...BASE, paperWidth: 420, paperHeight: 297, pageWidth: 210, pageHeight: 297 });
  assert.equal(exact.fit.ok, true);
  assert.equal(exact.fit.failCount, 0);
  allSlots(exact).forEach((s) => assert.deepEqual(s.fit.violations, []));
  // 爬移 5mm 时裁切框另一侧恰好贴合页位边界（220 页位放 210 页，居中余量 5mm）
  const r = computeImposition({
    ...BASE,
    paperWidth: 440, paperHeight: 310, pageWidth: 210, pageHeight: 297,
    paperThickness: 2.5, maxCompensation: 5,
  });
  assert.deepEqual(r.creep.sheetCompensationMm, [0, 5]);
  const f = r.signatures[0].sheets[1].front.left.fit;
  assert.deepEqual(f.trim, { x: 10, y: 6.5, width: 210, height: 297 }); // 右缘 220 = 页位边界
  assert.equal(f.ok, true);
  assert.deepEqual(f.violations, []);
});

test('出血框越过折线进入相邻页位不视为超限（裁切框仍在所属页位内）', () => {
  // 200×290 成品页在 220×310 页位内居中，第 2 张爬移 +6mm：
  // 裁切框右缘 216 仍在页位内，出血框右缘 224 越过折线（x=220）进入右页位，但仍在整张纸内
  const r = computeImposition({
    ...BASE,
    paperWidth: 440, paperHeight: 310, pageWidth: 200, pageHeight: 290,
    bleedMm: 8, paperThickness: 3, maxCompensation: 10,
  });
  const f = r.signatures[0].sheets[1].front.left.fit;
  assert.equal(f.trim.x + f.trim.width, 216); // ≤ 页位右缘 220
  assert.ok(f.bleedBox.x + f.bleedBox.width > r.fit.slotWidth); // 出血越过折线进入相邻页位
  assert.ok(f.bleedBox.x + f.bleedBox.width <= r.fit.paperWidth); // 但仍在整张纸内
  assert.equal(f.ok, true);
  assert.deepEqual(f.violations, []);
});

test('安全边距过大：safety-too-wide / safety-too-tall，safeBox 为 null', () => {
  const r = computeImposition({ ...BASE, paperWidth: 400, paperHeight: 200, pageWidth: 100, pageHeight: 60, safetyMm: 55 });
  const f = r.signatures[0].sheets[0].front.left.fit;
  const codes = f.violations.map((v) => v.code);
  assert.ok(codes.includes('safety-too-wide'));
  assert.ok(codes.includes('safety-too-tall'));
  assert.equal(f.safeBox, null);
  assert.match(f.violations.find((v) => v.code === 'safety-too-wide').message, /左右合计 110mm 超过成品页宽 100mm/);
});

test('页位方向：长边翻转背面 rotation=180，短边翻转背面 rotation=0', () => {
  const common = { ...BASE, paperWidth: 440, paperHeight: 310, pageWidth: 210, pageHeight: 297 };
  const longFlip = computeImposition({ ...common, flip: 'long' });
  assert.equal(longFlip.signatures[0].sheets[0].front.left.fit.rotation, 0);
  assert.equal(longFlip.signatures[0].sheets[0].back.left.fit.rotation, 180);
  assert.equal(longFlip.signatures[0].sheets[0].back.right.fit.rotation, 180);
  const shortFlip = computeImposition({ ...common, flip: 'short' });
  assert.equal(shortFlip.signatures[0].sheets[0].back.left.fit.rotation, 0);
});

test('空白页同样参与适配检查', () => {
  const r = computeImposition({
    totalPages: 10, sheetsPerSignature: 2, binding: 'left', flip: 'short',
    paperWidth: 440, paperHeight: 310, pageWidth: 210, pageHeight: 297,
  });
  const blank = r.signatures[1].sheets[1].front.left;
  assert.equal(blank.blank, true);
  assert.ok(blank.fit);
  assert.equal(blank.fit.ok, true);
  assert.equal(r.fit.totalSlots, 16);
});

test('适配检查不改变页码拼版与爬移结果', () => {
  const strip = (r) => JSON.parse(JSON.stringify(r.signatures, (k, v) => (k === 'fit' ? undefined : v)));
  const common = { ...BASE, paperThickness: 0.1, maxCompensation: 0.15 };
  const without = computeImposition(common);
  const withFit = computeImposition({
    ...common, paperWidth: 440, paperHeight: 310, pageWidth: 210, pageHeight: 297, bleedMm: 3, safetyMm: 5,
  });
  assert.deepEqual(strip(withFit), strip(without));
});

test('汇总统计：failCount 与 totalSlots 正确', () => {
  // 页高 = 纸高、页宽 = 页位宽：上下左右出血全部悬在纸外，8 个页位全不合格
  const r = computeImposition({ ...BASE, paperWidth: 420, paperHeight: 297, pageWidth: 210, pageHeight: 297, bleedMm: 3 });
  assert.equal(r.fit.totalSlots, 8);
  assert.equal(r.fit.failCount, 8);
  assert.equal(r.fit.ok, false);
});

test('适配检查参数校验', () => {
  // 只提供部分尺寸
  assert.throws(() => computeImposition({ ...BASE, paperWidth: 440 }), /必须同时大于 0/);
  assert.throws(() => computeImposition({ ...BASE, paperWidth: 440, paperHeight: 310, pageWidth: 210 }), /必须同时大于 0/);
  // 只给出血 / 安全边距但不给尺寸
  assert.throws(() => computeImposition({ ...BASE, bleedMm: 3 }), /未提供纸张与成品页尺寸/);
  assert.throws(() => computeImposition({ ...BASE, safetyMm: 5 }), /未提供纸张与成品页尺寸/);
  // 负值与非数字
  assert.throws(
    () => computeImposition({ ...BASE, paperWidth: -1, paperHeight: 310, pageWidth: 210, pageHeight: 297 }),
    /纸张宽/
  );
  assert.throws(
    () => computeImposition({ ...BASE, paperWidth: 440, paperHeight: 310, pageWidth: 210, pageHeight: 297, bleedMm: -1 }),
    /出血/
  );
  assert.throws(
    () => computeImposition({ ...BASE, paperWidth: 440, paperHeight: 310, pageWidth: 210, pageHeight: 297, safetyMm: 'x' }),
    /安全边距/
  );
});
