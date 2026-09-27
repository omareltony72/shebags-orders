# She Bags — Online Orders

- `index.html` — صفحة الأوردرات (بتترفع على Vercel كموقع static، مفيش build).
- `supabase/functions/api/index.ts` — السيرفر (Supabase Edge Function) اللي بيكلم Loyverse.
- Supabase project: `she-bags-orders` (hnyhclyurrbbskqgyopw).
- Secrets في Supabase: `LOYVERSE_TOKEN` (إجباري)، `LOYVERSE_STORE_ID` و`LOYVERSE_PAYMENT_TYPE_ID` (اختياري).

الحالات: جديد (يخصم من المخزون أول ما يتسجل) → مؤكد → تم التجهيز → مع شركة الشحن (بعد التصدير) → تم التحصيل / استلام جزئي / مرتجع.
الفاتورة في Loyverse بتتعمل أول ما الأوردر يتسجل (بتخصم من المخزون)، بطريقة دفع "اوردرات اونلاين" ومربوطة بالعميل.
الإلغاء في أي وقت، والمرتجع، والقطع الراجعة في الاستلام الجزئي — كلها بترجع للمخزون في Loyverse تلقائي.
