# قرارداد موتور فرم پله‌ای و Adapter آیندهٔ تجهیزات

## وضعیت و هدف

این سند قرارداد نسخهٔ ۱ برای موتور دامنه‌خنثای `public/platform-v2/step-wizard.js` است. درخواست کار و دستورکار از موتور در همین تغییر استفاده می‌کنند. `public/platform-v2/equipment-wizard-adapter.js` فقط نقطهٔ اتصال آینده و آزمون‌پذیر برای تغییر شمارهٔ ۲ است؛ در این مرحله فرم یا صفحهٔ تجهیزات را بازنویسی نمی‌کند و endpoint یا ساختار دادهٔ تازه‌ای برای تجهیزات نمی‌سازد.

## مسئولیت‌ها

- **موتور**: نمایش یک مرحله در هر نوبت، کارت‌های انتخاب، progress، شرط نمایش، ویرایش پاسخ، مرور نهایی، اعتبارسنجی، RTL، دسترس‌پذیری و تحویل پاسخ به callbackهای Adapter.
- **Adapter دامنه**: واکشی گزینه‌های Backend، سیاست مجوز، ایجاد/ادامهٔ پیش‌نویس نسخه‌دار در سرور، تبدیل مدل رابط به مدل دامنه، ثبت نهایی، پیام خطای API و مدیریت فایل موقت.
- **Backend**: منبع حقیقت، Permission، اعتبارسنجی نهایی، optimistic concurrency با `row_version`، تراکنش، Audit، Soft Delete و انتشار رویدادهای دامنه. موتور حق ذخیرهٔ عملیاتی در browser storage را ندارد.

## رابط موتور

```js
BFGStepWizard.create({
  root,                     // عنصر DOM ریشه
  title,
  eyebrow,
  steps,
  initialAnswers,
  initialStepId,
  onChange({ answers, stepId, progress }),
  onSubmit({ answers, serializedAnswers, state, wizard }),
  confirmSubmit,
  confirmText,
  submitLabel,
  onCancel,
  onAction,
  focusOnRender
});
```

مقدار بازگشتی شامل `getAnswers()`, `getSerializedAnswers()`, `getCurrentStep()`, `getProgress()`, `setAnswer()`, `goTo()`, `next()`, `back()`, `render()`, `flush()` و `destroy()` است. `onChange` پیش‌نویس را ذخیره می‌کند؛ موتور خودش fetch، storage، یا تصمیم دامنه‌ای انجام نمی‌دهد. ثبت نهایی تنها از مسیر `onSubmit` و پس از تیک صریح مرور و موفقیت `confirmSubmit` فراخوانی می‌شود.

### شکل مرحله‌ها

```js
{
  id: 'equipmentIdentity',
  kind: 'group',              // choice, multi-choice, text, textarea, number,
                              // select, file, jalali-date, jalali-datetime,
                              // custom, review نیز پشتیبانی می‌شوند
  title: 'مشخصات تجهیز',
  description: 'راهنمای کوتاه',
  required: false,
  visibleWhen: answers => Boolean(answers.factoryId),
  fields: [
    { id: 'factoryId', kind: 'choice', label: 'کارخانه', required: true,
      options: answers => [{ value: 'server-id', label: 'مقدار واقعی Backend' }] }
  ],
  onChange: async ({ answers, value, setAnswer, context }) => {}
}
```

- `id`ها باید پایدار، دامنه‌دار و یکتا باشند؛ ID گزینه باید شناسهٔ واقعی همان منبع باشد.
- `options` می‌تواند آرایه یا تابعی از پاسخ‌ها/Context باشد. «سایر» با `allowOther:true` فعال و متن آن با کلید `<id>Other` نگهداری می‌شود.
- `visibleWhen(answers)` مرحله/فیلد شرطی را کنترل می‌کند؛ تغییر پاسخ، مراحل پنهان را از مسیر پیمایش حذف می‌کند.
- ورودی‌های متنی هنگام تایپ ذخیره می‌شوند؛ `onChange` فیلد در رویداد `change` اجرا می‌شود. برای ورودی/گزینه‌ای که تغییرش نیازمند بازترسیم فوری همان مرحله است، `renderOnChange:true` تعریف شود؛ در غیر این صورت فوکوس کاربر حفظ می‌شود.
- موتور متد `cancel()` دارد تا Adapter بتواند بستن سرصفحه و Escape را نیز از مسیر ذخیره/لغو کنترل‌شده عبور دهد.
- `kind:'custom'` برای UI اختصاصی قابل دسترس استفاده می‌شود؛ تعامل بیرونی از `data-sw-action="custom"` و `onAction` عبور می‌کند.
- `kind:'review'` خلاصهٔ مرحله‌های قابل مشاهده را می‌سازد و دکمهٔ «ویرایش» همان مرحله را باز می‌کند. مرحلهٔ مرور در ثبت نهایی تیک صریح می‌خواهد.
- فایل فقط در حافظهٔ همان نشست صفحه باقی می‌ماند؛ `kind:'file'` در `serializedAnswers()` حذف می‌شود. Adapter باید فایل را پس از ثبت یا از مسیر آپلود مجاز Backend ارسال کند.
- `jalali-date` و `jalali-datetime` در UI شمسی‌اند. Adapter باید تاریخ معتبر را به میلادی/ISO تبدیل و در Backend ذخیره کند.

## قرارداد Adapter تجهیزات (آماده برای تغییر ۲)

```js
const contract = {
  resource: 'equipment',
  version: 1,
  steps: [
    { id: 'identity', kind: 'group', title: 'شناسایی تجهیز', fields: [/* ... */] },
    { id: 'review', kind: 'review', title: 'مرور مشخصات' }
  ]
};

const wizard = BFGEquipmentWizardAdapter.create({
  root: document.querySelector('#equipment-wizard'),
  engine: BFGStepWizard,
  contract,
  initialAnswers: {},
  persistDraft: payload => existingEquipmentRepository.saveDraft(payload),
  submit: payload => existingEquipmentRepository.submit(payload),
  confirmSubmit: () => existingConfirmationFlow(),
  confirmText: 'اطلاعات تجهیز را بررسی و تأیید می‌کنم.'
});
```

Adapter قرارداد `resource`, `version`, `steps`, `root`, `persistDraft` و `submit` را بررسی می‌کند و callbackها را با `{resource:'equipment', contractVersion:1}` مشخص می‌کند. Service/endpoint واقعی، قاعدهٔ Permission، Migration یا اتصال به صفحهٔ فعلی تجهیزات در تغییر ۱ تعریف نمی‌شود؛ تغییر ۲ باید از Repository/API موجود پروژه استفاده کند و منبع داده یا Asset Form را موازی نسازد.

## الزامات پذیرش تغییر ۲

- ابتدا API، schema، مجوزها، adapter و فرم تجهیزات موجود را بررسی کند؛ هیچ فرم/دادهٔ موجودی را با dummy data جایگزین نکند.
- پیش‌نویس تجهیزات در Backend نسخه‌دار باشد؛ پاسخ عملیاتی در `localStorage`/`sessionStorage` ذخیره نشود.
- Permission و scope در Backend اعمال شود، `row_version`, Audit, Soft Delete و Realtime حفظ شوند.
- فرم فعلی تجهیزات و شناسه‌ها فقط با قرارداد تغییر ۲ و تأیید صریح دامنه تغییر کنند.
- آزمون‌های Contract باید payload Adapter، بازگشت به مرحله، شرط‌ها، مرور/تأیید، stale version، عدم storage محلی و API واقعی را پوشش دهند.
