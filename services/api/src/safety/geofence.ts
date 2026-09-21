import type { GeofenceState } from './safety.constants';

/**
 * Geofence değerlendirmesi.
 *
 * İki tasarım kararı bu dosyanın tamamını açıklar:
 *
 * **1. Sonuç ikili değildir.** "İçeride / dışarıda" ikilisi, GPS'in gerçekte ne
 * verdiğini yok sayar: her örnek bir nokta değil, bir **belirsizlik dairesidir**
 * (`accuracy_meters`). 40 metre doğrulukla ölçülmüş bir konum, sınırdan 20 metre
 * ötede görünse bile içeride olabilir. Bu yüzden dört sonuç vardır ve ikisi
 * "bilmiyoruz" der. Zayıf sinyali "dışarıda" saymak, kapalı alanda çalışan bir
 * sağlayıcıyı kaçmış gibi gösterirdi — güvenlik sisteminin en pahalı yanlış alarmı.
 *
 * **2. Geçişler debounce edilir.** Ham GPS sınırın etrafında saniyede birkaç kez
 * içeri-dışarı zıplar (jitter). Her zıplamayı olay yazmak, uyuşmazlık dosyasını
 * gürültüyle doldurur ve gerçek bir çıkışı görünmez kılar.
 *
 * Hiçbir geofence sonucu tek başına "hizmet başladı", "hizmet bitti", "dolandırıcılık
 * var" ya da "kullanıcı tehlikede" anlamına **gelmez** (ADR-0008 §7). Bir sinyaldir.
 */

export interface GeofenceEvaluation {
  state: GeofenceState;
  distanceMeters: number;
  accuracyMeters: number;
}

export interface GeofenceInput {
  distanceMeters: number;
  accuracyMeters: number;
  radiusMeters: number;
  accuracyLimitMeters: number;
}

/**
 * Sınırın iki yanındaki histerezis bandı (metre).
 *
 * Belirsizlik dairesi tek başına jitter'ı süzmeye yetmez: doğruluk 3 metre
 * bildirilen bir örnek sınırın 1 metre içinde/dışında zıplayıp durursa, bant
 * yalnızca 6 metre olurdu. Yarıçapın %10'u (en az 10 m) kadar bir bant, sınırda
 * duran bir sağlayıcının "girdi/çıktı" üretmesini engeller. Bant, kesin yargıyı
 * **zorlaştırır**, kolaylaştırmaz: içeride saymak için daha içeride, dışarıda
 * saymak için daha dışarıda olmak gerekir.
 */
export function hysteresisMeters(radiusMeters: number): number {
  return Math.max(10, Math.round(radiusMeters * 0.1));
}

export function evaluateGeofence(input: GeofenceInput): GeofenceEvaluation {
  const base = {
    distanceMeters: input.distanceMeters,
    accuracyMeters: input.accuracyMeters,
  };

  // Doğruluk yarıçapla kıyaslanamayacak kadar kötüyse hiçbir yargı üretilmez.
  // Örnek yine saklanır (hareket/boşluk analizi için değerlidir), yalnızca
  // geofence kararına girmez.
  if (!Number.isFinite(input.accuracyMeters) || input.accuracyMeters > input.accuracyLimitMeters) {
    return { ...base, state: 'INSUFFICIENT_ACCURACY' };
  }

  const band = hysteresisMeters(input.radiusMeters);

  // Belirsizlik dairesi, bandın içinde kalan bölgeye tamamen sığıyor.
  if (input.distanceMeters + input.accuracyMeters <= input.radiusMeters - band) {
    return { ...base, state: 'INSIDE' };
  }

  // Belirsizlik dairesi, bandın dışında kalan bölgede.
  if (input.distanceMeters - input.accuracyMeters > input.radiusMeters + band) {
    return { ...base, state: 'OUTSIDE' };
  }

  // Daire sınırı ya da bandı kesiyor: kesin bir şey söylenemez.
  return { ...base, state: 'BOUNDARY' };
}

export interface DebounceState {
  /** Kayıtlı (kabul edilmiş) durum. */
  current: GeofenceState;
  /** Değişim için biriken aday durum. */
  candidate: GeofenceState | null;
  candidateCount: number;
}

export interface DebounceResult {
  next: DebounceState;
  /** Kabul edilmiş bir durum değişikliği oluştu mu? */
  transitioned: boolean;
}

/**
 * Bir gözlemi debounce durumuna uygular.
 *
 * Kural: bir durum, **ardışık `threshold` gözlem** boyunca kendini tekrar ederse
 * kabul edilir. Araya farklı bir gözlem girerse sayaç sıfırlanır.
 *
 * `BOUNDARY` ve `INSUFFICIENT_ACCURACY` aday **olamaz**: "bilmiyorum" bir duruma
 * geçiş gerekçesi değildir. Bunlar yalnızca mevcut adayı sıfırlar — yani belirsiz
 * bir dizi, kayıtlı durumu olduğu gibi bırakır. Aksi hâlde tünele giren bir
 * sağlayıcı "çıktı" sayılırdı.
 */
export function applyDebounce(
  state: DebounceState,
  observation: GeofenceState,
  threshold: number,
): DebounceResult {
  if (observation === 'BOUNDARY' || observation === 'INSUFFICIENT_ACCURACY') {
    return {
      next: { current: state.current, candidate: null, candidateCount: 0 },
      transitioned: false,
    };
  }

  if (observation === state.current) {
    // Zaten kayıtlı durumdayız: biriken aday düşer.
    return {
      next: { current: state.current, candidate: null, candidateCount: 0 },
      transitioned: false,
    };
  }

  const count = state.candidate === observation ? state.candidateCount + 1 : 1;

  if (count >= threshold) {
    return {
      next: { current: observation, candidate: null, candidateCount: 0 },
      transitioned: true,
    };
  }

  return {
    next: { current: state.current, candidate: observation, candidateCount: count },
    transitioned: false,
  };
}
