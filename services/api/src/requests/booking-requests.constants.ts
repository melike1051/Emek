/**
 * Serbest metin üst sınırı.
 *
 * AI servisindeki sınırla (MAX_RAW_TEXT_LENGTH = 2000) **aynı** olmak zorunda:
 * core daha uzun metni kabul edip AI'ya gönderseydi, orada sessizce kırpılır ve
 * kullanıcının yazdığının bir kısmı kaybolurdu.
 */
export const MAX_RAW_TEXT_LENGTH = 2000;
