/* Contract adapter for a future Equipment wizard. This file does not replace or open
   the current Equipment pages; the next change supplies its own Backend adapters. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BFGEquipmentWizardAdapter = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const CONTRACT_VERSION = 1;

  function create(options) {
    if (!options || !options.root) throw new Error('EQUIPMENT_WIZARD_ROOT_REQUIRED');
    const engine = options.engine || (typeof window !== 'undefined' && window.BFGStepWizard);
    if (!engine || typeof engine.create !== 'function') throw new Error('STEP_WIZARD_ENGINE_REQUIRED');
    const contract = options.contract;
    if (!contract || contract.resource !== 'equipment' || contract.version !== CONTRACT_VERSION || !Array.isArray(contract.steps) || !contract.steps.length) {
      throw new Error('EQUIPMENT_WIZARD_CONTRACT_INVALID');
    }
    if (typeof options.persistDraft !== 'function' || typeof options.submit !== 'function') throw new Error('EQUIPMENT_BACKEND_ADAPTER_REQUIRED');

    return engine.create({
      root:options.root,
      title:options.title || 'تعریف و تکمیل مشخصات تجهیز',
      eyebrow:'آماده‌سازی برای تغییر شماره ۲',
      initialAnswers:options.initialAnswers || {},
      steps:contract.steps,
      onChange:payload => options.persistDraft({ resource:'equipment', contractVersion:CONTRACT_VERSION, ...payload }),
      confirmText:options.confirmText || 'اطلاعات تجهیز را بررسی و تأیید می‌کنم.',
      submitLabel:options.submitLabel || 'ثبت تجهیز در سرور',
      confirmSubmit:options.confirmSubmit,
      onSubmit:payload => options.submit({ resource:'equipment', contractVersion:CONTRACT_VERSION, ...payload })
    });
  }

  return { CONTRACT_VERSION, create };
});
