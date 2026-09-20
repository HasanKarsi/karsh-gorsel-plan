# karsh-gorsel-plan

Görsel sıkıştırmanın **kararları**: bir dosyanın gerçekte ne olduğu, ne
olacağı, ne kadar küçüleceği, ne adla ineceği ve makinenin onu şu anda açmaya
gücünün yetip yetmediği. Kodek yok, DOM yok, bağımlılık yok — bu yüzden adı
"sıkıştırıcı" değil "plan".

*The **decisions** behind image compression: what a file really is, what it can
become, how it will be scaled, what it will be called, and whether the machine
can afford to start it now. No codec, no DOM, no dependencies — which is why
this is a plan, not a compressor.*

---

## Türkçe

### Ne işe yarar

Bir sıkıştırma aracının kodeklerden geriye kalan her şeyi. Kodlayıcılar
(MozJPEG, libwebp, libavif, OxiPNG — WebAssembly halleri) bilerek dışarıda:
onlar megabaytlarca ikili dosya, buradaki ise bayt ve sayı aritmetiği. Ayrı
durdukları için bu dosya sayfada, worker'ın içinde ve Node'da aynı şekilde
çalışır; gerçek dosya başlıklarına karşı sınanabilir.

İçindeki kararlar:

- **Format, başlıktan okunur** — dosya adından ya da tarayıcının tahmin ettiği
  MIME'den değil. `.jpg` uzantılı bir PNG, uzantısı silinmiş bir HEIC ve
  tarayıcının hiç açamayacağı bir TIFF, açılmadan önce tanınır.
- **Saklanan ölçü** — 200 megapiksellik bir panorama, iki gigabaytlık RGBA'ya
  çözülmeye çalışılmadan önce reddedilebilsin diye başlıktan okunur.
- **"Aynı format" ne demek** — GIF ve BMP kayıpsız olsun diye PNG olur (logo
  ya da ekran görüntüsü JPEG bloklarına bulaşmasın); yalnızca Safari'nin
  çözdüğü HEIC bir fotoğraf makinesi karesidir, JPEG olur.
- **Bellek bütçesi** — her iş kendi karesini, küçültülmüş kopyasını ve
  kodlayıcının kopyasını bellekte tutar; eşzamanlılık bu yüzden dosya sayısıyla
  değil piksel sayısıyla sınırlanır. Ne kadar büyük olursa olsun bir iş her
  zaman başlar, yoksa tek büyük dosya sonsuza kadar bekler.
- **Metadata soyma** — yeniden kodlama sonucu daha büyük çıktığı için orijinali
  saklayan kullanıcıya, EXIF'i ve GPS'i alınmış ama pikseli hiç dokunulmamış
  dosyayı verir. Güvenle yapılamıyorsa (AVIF, GIF, HEIC, bozuk dosya) `null`
  döner — sessizce "temizledim" demez.

### Kurulum

Paket derlenmiş dosya taşımaz; TypeScript kaynağı olduğu gibi yayımlanır
(`exports` doğrudan `src/index.ts`'i gösterir). Build adımı yoktur.

```bash
npm i github:<kullanıcı>/karsh-gorsel-plan
```

Node 18 ve üzeri, ya da herhangi bir tarayıcı/worker. Tek kullandığı ortam
API'si `TextDecoder` (SVG başlığını okumak için).

### Kullanım

**1. Bu dosya gerçekte ne?**

```ts
import { inspectHeader, HEADER_BYTES, looksLikeImage, LIMITS } from "karsh-gorsel-plan";

looksLikeImage(".DS_Store", "");      // false — klasör sürüklenince gelenler sayılır, listelenmez
looksLikeImage("foto.HEIC", "");      // true

const bytes = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer());
const head = inspectHeader(bytes);
// { format: "png", width: 512, height: 512, animated: false }

// Çözmeden önce reddet: 50 MP üstü bir kare bu sekmeyi düşürür.
const pixels = (head.width ?? 0) * (head.height ?? 0);
const tooBig = pixels > LIMITS.megapixels * 1_000_000;
```

**2. Ne çıkacak, ne adla?**

```ts
import { resolveOutputFormat, fitWithin, ENCODER_MAX_SIDE, outputFilename, settingsKey } from "karsh-gorsel-plan";

resolveOutputFormat("heic", "same");  // "jpeg" — fotoğraf makinesi karesi
resolveOutputFormat("gif", "same");   // "png"  — kayıpsız kalsın

fitWithin(6000, 4000, 1920);                            // { width: 1920, height: 1280 }
fitWithin(20000, 800, 0, ENCODER_MAX_SIDE.webp);        // { width: 16383, height: 655 }
// WebP ölçüyü 14 bitte saklar: sınır formatın kendisinden gelir, uydurulmaz.

outputFilename("Düğün 014.JPG", "webp");   // "Düğün 014.webp" — ad kullanıcınındır
outputFilename("rapor: 2026/Q1.png", "avif"); // "rapor- 2026-Q1.avif" — yalnızca yasak karakterler değişir

settingsKey({ format: "jpeg", quality: 78, pngLevel: 2, maxSide: 1920 }, { width: 6000, height: 4000 });
// "jpeg:q78:1920x1280" — JPEG kalitesi oynayınca PNG'ler yeniden kodlanmasın diye
// anahtara yalnızca seçilen formatın okuduğu ayarlar girer.
```

**3. Şimdi başlasın mı, sonuç ne oldu?**

```ts
import { canStartJob, sizeChange, stripMetadata } from "karsh-gorsel-plan";

canStartJob([], 48_000_000, 40_000_000, 3);                    // true — ilk iş her zaman başlar
canStartJob([12_000_000, 12_000_000], 48_000_000, 40_000_000, 3); // false — bütçe yetmiyor

sizeChange(2_400_000, 312_000);  // { kind: "smaller", share: 0.87 }
sizeChange(18_000_000, 848);     // { kind: "smaller", share: 0.99 } — "%100 küçüldü" boş dosya demektir
sizeChange(100_000, 100_200);    // { kind: "same" } — binde beşin altı değişiklik sayılmaz

const clean = stripMetadata(bytes); // EXIF ve GPS gider, piksel aynı kalır
// null ise: bu dosya için güvenle yapılamıyor, arayüz bunu söylemek zorunda
```

### API

| İmza | Ne yapar |
| --- | --- |
| `inspectHeader(bytes)` | İlk baytlardan `{ format, width, height, animated }`. `format`: `jpeg`, `png`, `gif`, `webp`, `avif`, `bmp`, `heic`, `tiff`, `svg`, `unknown`. |
| `HEADER_BYTES` | `inspectHeader`'ın istediği baş kısım (512 KB): JPEG'in kare başlığı, gömülü önizlemeli bir EXIF bloğunun arkasında kalabilir. |
| `looksLikeImage(name, type)` | Bırakılan dosya bir satırı hak ediyor mu — MIME ya da uzantı. |
| `resolveOutputFormat(source, choice)` | "Aynı format" seçiminin bu kaynak için gerçek karşılığı. |
| `fitWithin(width, height, maxSide, encoderMax)` | En uzun kenarı sınıra indirilmiş ölçü; oran korunur, asla büyütmez, bir pikselin altına inmez. |
| `outputFilename(name, format)` | Kullanıcının adı + yeni uzantı; yalnızca hiçbir dosya sisteminin kabul etmediği karakterler değişir. |
| `settingsKey(settings, stored)` | "Bu ayarların ürettiği sonuç" için kararlı anahtar — önbelleği gereksiz yere düşürmez. |
| `flattenOnWhite(data)` | RGBA'yı yerinde beyaz üstüne düzler, saydamlık var mıydı onu döner. JPEG'in alfa kanalı yoktur; düzlenmemiş saydam logo siyah çıkar. |
| `savedRatio(before, after)` · `sizeChange(before, after)` | Kazanç oranı; ve o oranın nasıl söyleneceği (`same`, `smaller`, `larger`). |
| `stripMetadata(bytes)` | Metadata'sı alınmış, pikseli dokunulmamış dosya — ya da güvenle yapılamıyorsa `null`. JPEG, PNG, WebP ve BMP için çalışır. |
| `canStartJob(runningPixels, nextPixels, budget, maxJobs)` | Bir iş daha başlayabilir mi: hem sayı hem piksel bütçesi. |
| `MIME` · `EXTENSION` · `OUTPUT_CHOICES` | Yazılabilen formatların MIME'i, uzantısı ve kullanıcıya sunulan seçenekler. |
| `DEFAULT_QUALITY` · `PNG_LEVELS` · `MAX_SIDE_PRESETS` | Başlangıç kaliteleri (ölçekler aynı ölçek değil: AVIF 55, JPEG 80 gibi görünür), OxiPNG seviyeleri, kenar hazır ayarları. |
| `LIMITS` · `ENCODER_MAX_SIDE` | Toplu işte dosya sayısı ve megapiksel tavanı; her kodlayıcının kabul ettiği en uzun kenar. |

### Neden kütüphane değil, elle yazıldı

Hazır sıkıştırma paketleri kodeği de içeri alır ve kararları saklar: hangi
formata geçileceğini, ne zaman küçültüleceğini, ne zaman durulacağını kendileri
seçer, seçimi de anlatmaz. Bir arayüz için lazım olan tam tersiydi — kararlar
görünür ve sınanabilir olsun, kodek ise ayrı dursun ki sayfa onu yalnızca
gerektiğinde indirsin.

Ayrılınca üç şey kazanıldı. Birincisi, bu dosya DOM istemediği için testler
gerçek dosya başlıklarıyla Node'da koşuyor. İkincisi, kodlayıcı değiştirmek
(WebAssembly halinden native'e, ya da tersine) karar katmanına dokunmuyor.
Üçüncüsü, "ne olacağını" dosyaya bakmadan söyleyebilmek — `settingsKey` bir
önbellek anahtarı üretiyor, `canStartJob` işin şimdi başlayıp
başlayamayacağını söylüyor — bir toplu işin akışını kurmanın tek dürüst yolu.

Tanıma tarafı da kütüphaneden alınamazdı: burada format dosya adından değil
ilk baytlardan okunur, çünkü tarayıcının verdiği MIME bazen boş, bazen yanlış,
bazen de "application/octet-stream"dir.

### Lisans

MIT — bkz. [LICENSE](./LICENSE).

---

## English

### What it is for

Everything a compression tool is once the codecs are taken out. The encoders
(MozJPEG, libwebp, libavif, OxiPNG in their WebAssembly builds) are left out on
purpose: they are megabytes of binary, while this is arithmetic over bytes and
numbers. Kept apart, it runs the same in the page, in a worker and under Node,
where it can be tested against real file headers.

The decisions inside:

- **The format is read from the header** — not from the name and not from the
  MIME type the browser guessed. A PNG called `.jpg`, a HEIC with its extension
  stripped and a TIFF no browser will open are all recognised before anything
  tries to decode them.
- **The stored size** is read from the header too, so a 200-megapixel panorama
  can be refused before it becomes two gigabytes of RGBA.
- **What "same format" means** — GIF and BMP become PNG, the lossless choice,
  so a logo or a screenshot is not smeared into JPEG blocks; HEIC, which only
  Safari decodes, is a camera photo, so JPEG.
- **A memory budget** — each running job holds its source frame, a resized copy
  and the encoder's own copy, so concurrency is capped by pixels as well as by
  count. One job always runs, however large, or a single big file would wait
  for ever.
- **Metadata stripping** — for the visitor who keeps an original because
  re-encoding made it bigger: EXIF and GPS gone, pixels untouched. When that
  cannot be done safely (AVIF, GIF, HEIC, a damaged file) it returns `null`
  rather than quietly claiming the file is clean.

### Install

No build step and no compiled files: the package ships TypeScript source and
`exports` points straight at `src/index.ts`.

```bash
npm i github:<user>/karsh-gorsel-plan
```

Node 18 or newer, or any browser or worker. The only platform API it uses is
`TextDecoder`, to read an SVG header.

### Usage

**1. What is this file, really?**

```ts
import { inspectHeader, HEADER_BYTES, looksLikeImage, LIMITS } from "karsh-gorsel-plan";

looksLikeImage(".DS_Store", ""); // false — what a dragged folder brings along is counted, not listed
looksLikeImage("photo.HEIC", ""); // true

const bytes = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer());
const head = inspectHeader(bytes);
// { format: "png", width: 512, height: 512, animated: false }

// Refuse before decoding: a frame over 50 MP takes the tab down.
const pixels = (head.width ?? 0) * (head.height ?? 0);
const tooBig = pixels > LIMITS.megapixels * 1_000_000;
```

**2. What comes out, and under what name?**

```ts
import { resolveOutputFormat, fitWithin, ENCODER_MAX_SIDE, outputFilename, settingsKey } from "karsh-gorsel-plan";

resolveOutputFormat("heic", "same"); // "jpeg" — a camera photo
resolveOutputFormat("gif", "same");  // "png"  — keep it lossless

fitWithin(6000, 4000, 1920);                     // { width: 1920, height: 1280 }
fitWithin(20000, 800, 0, ENCODER_MAX_SIDE.webp); // { width: 16383, height: 655 }
// WebP stores dimensions in 14 bits: the limit comes from the format, not from a guess.

outputFilename("Düğün 014.JPG", "webp");      // "Düğün 014.webp" — the name is theirs
outputFilename("report: 2026/Q1.png", "avif"); // "report- 2026-Q1.avif" — only illegal characters change

settingsKey({ format: "jpeg", quality: 78, pngLevel: 2, maxSide: 1920 }, { width: 6000, height: 4000 });
// "jpeg:q78:1920x1280" — only what the chosen format reads goes in, so moving the
// JPEG slider does not redo the PNGs.
```

**3. May it start, and what happened?**

```ts
import { canStartJob, sizeChange, stripMetadata } from "karsh-gorsel-plan";

canStartJob([], 48_000_000, 40_000_000, 3);                       // true — one job always runs
canStartJob([12_000_000, 12_000_000], 48_000_000, 40_000_000, 3); // false — over budget

sizeChange(2_400_000, 312_000); // { kind: "smaller", share: 0.87 }
sizeChange(18_000_000, 848);    // { kind: "smaller", share: 0.99 } — "100 % smaller" reads as an empty file
sizeChange(100_000, 100_200);   // { kind: "same" } — under half a percent is no change

const clean = stripMetadata(bytes); // EXIF and GPS go, the picture does not change
// null: not safe for this file, and the interface has to say so
```

### API

| Signature | What it does |
| --- | --- |
| `inspectHeader(bytes)` | `{ format, width, height, animated }` from the first bytes. `format`: `jpeg`, `png`, `gif`, `webp`, `avif`, `bmp`, `heic`, `tiff`, `svg`, `unknown`. |
| `HEADER_BYTES` | How many leading bytes `inspectHeader` wants (512 KB): a JPEG's frame header sits behind its EXIF block, preview and all. |
| `looksLikeImage(name, type)` | Whether a dropped file is worth a row — by MIME type or by extension. |
| `resolveOutputFormat(source, choice)` | What "same as the input" actually means for this source. |
| `fitWithin(width, height, maxSide, encoderMax)` | The longest side brought down to the limit; ratio kept, never enlarged, never below one pixel. |
| `outputFilename(name, format)` | The visitor's own name with the new extension; only characters no filesystem accepts are replaced. |
| `settingsKey(settings, stored)` | A stable key for "the result these settings produce", so a cache is not dropped for nothing. |
| `flattenOnWhite(data)` | Composites RGBA over white in place and reports whether anything was transparent. JPEG has no alpha; unflattened, a transparent logo comes out on black. |
| `savedRatio(before, after)` · `sizeChange(before, after)` | The share saved, and how that share should be worded (`same`, `smaller`, `larger`). |
| `stripMetadata(bytes)` | The file with its metadata removed and its picture untouched — or `null` when that cannot be done safely. JPEG, PNG, WebP and BMP. |
| `canStartJob(runningPixels, nextPixels, budget, maxJobs)` | Whether another job may start: by count and by pixel budget. |
| `MIME` · `EXTENSION` · `OUTPUT_CHOICES` | MIME type and extension per writable format, and the choices offered to a visitor. |
| `DEFAULT_QUALITY` · `PNG_LEVELS` · `MAX_SIDE_PRESETS` | Starting qualities (the scales are not one scale: AVIF at 55 looks like JPEG at 80), OxiPNG levels, longest-side presets. |
| `LIMITS` · `ENCODER_MAX_SIDE` | Files per batch and the megapixel ceiling; the largest side each encoder accepts. |

### Why this is written out rather than pulled in

Off-the-shelf compression packages bring the codec with them and keep the
decisions to themselves: which format to move to, when to scale, when to stop —
chosen for you and never explained. An interface needs the opposite: decisions
visible and testable, the codec kept separate so the page can fetch it only
when it is actually needed.

Separating them paid three times. The tests run in Node against real file
headers, because nothing here touches the DOM. Swapping an encoder (WebAssembly
for native, or back) does not touch the decision layer. And being able to say
what will happen without looking at the pixels — `settingsKey` produces a cache
key, `canStartJob` answers whether this job may start now — is the only honest
way to drive a batch.

Detection could not have been borrowed either: here the format comes from the
first bytes rather than the file name, because the MIME type a browser hands
over is sometimes empty, sometimes wrong, and sometimes
`application/octet-stream`.

### License

MIT — see [LICENSE](./LICENSE).
