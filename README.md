# She Bags — Online Orders

- `index.html` — صفحة الأوردرات (بتترفع على Vercel كموقع static، مفيش build).
- `supabase/functions/api/index.ts` — السيرفر (Supabase Edge Function) اللي بيكلم Loyverse.
- Supabase project: `she-bags-orders` (hnyhclyurrbbskqgyopw).
- Secrets في Supabase: `LOYVERSE_TOKEN` (إجباري)، `LOYVERSE_STORE_ID` و`LOYVERSE_PAYMENT_TYPE_ID` (اختياري).

الحالات: جديد → مؤكد (يخصم من المخزون ويسجّل العميل في Loyverse) → تم التجهيز → مع شركة الشحن (بعد التصدير) → تم التحصيل / استلام جزئي / مرتجع.
الفاتورة في Loyverse بتتعمل وقت التحصيل بالقطع اللي اتباعت فعلاً فقط، بطريقة دفع "اوردرات اونلاين".
