import express from 'express';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { fal } from '@fal-ai/client';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ضبط حجم البيانات المسموح به لاستقبال الصور الكبيرة بدون أخطاء PayloadTooLarge
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(__dirname)); 

// الربط بقاعدة بيانات Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// إعداد مفتاح FAL_KEY لمكتبة fal
fal.config({
    credentials: process.env.FAL_KEY
});

// ================= اختبار الاتصال بقاعدة البيانات =================
async function testDatabaseConnection() {
    console.log("جاري اختبار الاتصال بقاعدة البيانات لـ Supabase...");
    const { data, error } = await supabase
        .from('user')
        .select('*')
        .eq('code', '12345678');
        
    if (error) {
        console.error("❌ فشل الاتصال بقاعدة البيانات! السبب:", error.message);
    } else if (!data || data.length === 0) {
        console.log("❌ الاتصال ناجح لكن لم يتم العثور على الكود 12345678 في الجدول.");
    } else {
        console.log("✅ نجح الاتصال بقاعدة البيانات! البيانات المسترجعة لأول صف:");
        console.log(`الكود: ${data[0].code} | الرصيد الحالي في جدولك: ${data[0].balance}`);
    }
}
testDatabaseConnection();
// ============================================================

// الـ API الأساسي للتحقق من الكود أو تنفيذ الرندر المعماري
app.post('/api/verify', async (req, res) => {
    const { code, action, image } = req.body;

    if (!code || code.length !== 8) {
        return res.status(400).json({ success: false, message: "الكود غير مكتمل أو غير صالح" });
    }

    try {
        const { data, error } = await supabase
            .from('user')
            .select('*')
            .eq('code', code);

        if (error) {
            return res.status(500).json({ success: false, message: "حدث خطأ أثناء جلب البيانات" });
        }

        if (!data || data.length === 0) {
            return res.status(401).json({ success: false, message: "هذا الكود غير صحيح أو غير موجود بقاعدة البيانات" });
        }

        const tokenData = data[0];

        if (tokenData.balance <= 0) {
            return res.status(403).json({ success: false, credits: 0, message: "عذراً، هذا الكود انتهى رصيده تماماً (0)" });
        }

        // الحالة الأولى: التحقق من الكود عند الدخول
        if (action === 'verify') {
            return res.json({ success: true, credits: tokenData.balance, message: "الكود صحيح ولديك رصيد كافٍ للدخول" });
        }

        // الحالة الثانية: تنفيذ الرندر وتحسين الجودة عبر fal وخصم النقطة
        if (action === 'render') {
            if (!image) {
                return res.status(400).json({ success: false, message: "لم يتم إرسال الصورة المطلوبة للرندر" });
            }

            // تجهيز ورفع الصورة لموقع fal
            let imageUrl = image;
            if (image.startsWith('data:image')) {
                const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
                const buffer = Buffer.from(base64Data, 'base64');
                const file = new File([buffer], "input_image.png", { type: "image/png" });
                const uploadedUrl = await fal.storage.upload(file);
                imageUrl = uploadedUrl;
            }

            console.log(`🚀 جاري إرسال الطلب لموديل fal للكود: ${code} (مهلة الاتصال مفتوحة)...`);

            // تشغيل الرندر باستخدام الموديل والبرومت الثابت والإعدادات مع فتح الاتصال بالكامل
            const result = await fal.subscribe("fal-ai/flux-2-lora-gallery/apartment-staging", {
                input: {
                    image_urls: [imageUrl],
                    prompt: "Professional  photograph, soft balanced scene exposure, realistic photography style. Turn ON all physically existing built-in chandeliers and spotlights. Modify the architectural render prompt to strictly reinforce the negative constraint against inventing or adding a chandelier if it is not physically present in the original image. If a chandelier is already physically present in the original scene, it must simply be turned ON  Very subtle lighting . Adaptively preserve and softly enhance the existing natural daylight from the windows, keeping a perfectly balanced daylight ambience without any overexposure or burnt highlights on the curtains or walls. High-fidelity textures with enhanced visual sharpness and clarity, featuring a controlled and balanced amount of rich color saturation, strict geometric fidelity, clean render.If there are sun rays in the scene, render them with a soft appearance, along with the shadows.",
                    guidance_scale: 3.5,
                    num_inference_steps: 40,
                    lora_scale: 0.3,
                    output_format: "png"
                },
                onQueueUpdate: (update) => {
                    if (update.status === "IN_PROGRESS" && update.logs) {
                        update.logs.map((log) => log.message).forEach(console.log);
                    }
                }
            });

            const outputImageUrl = result.data?.images?.[0]?.url;
            if (!outputImageUrl) {
                return res.status(500).json({ success: false, message: "فشل توليد الصورة من موديل الرندر" });
            }

            // خصم نقطة واحدة من رصيد المستخدم في قاعدة بيانات Supabase
            const newBalance = tokenData.balance - 1;
            const { error: updateError } = await supabase
                .from('user')
                .update({ balance: newBalance })
                .eq('id', tokenData.id);

            if (updateError) {
                return res.status(500).json({ success: false, message: "فشل تحديث وتعديل الرصيد في قاعدة البيانات" });
            }

            console.log(`✅ تمت الرندرة وخصم النقطة بنجاح. الرصيد الجديد: ${newBalance}`);

            return res.json({ 
                success: true, 
                credits: newBalance, 
                outputUrl: outputImageUrl, 
                message: "تم الرندر بنجاح واستهلاك نقطة!" 
            });
        }

    } catch (err) {
        console.error("Error during render:", err);
        return res.status(500).json({ success: false, message: "خطأ داخلي في السيرفر أثناء معالجة الرندر" });
    }
});

app.listen(PORT, () => {
    console.log(`السيرفر شغال بنجاح على بورت: ${PORT}`);
    console.log(`افتح الموقع من هنا وجرب الكود: http://localhost:${PORT}`);
});