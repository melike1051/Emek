import 'api_client.dart';
import 'api_error.dart';

/// Müşteri akışının modelleri ve uçları. Kaynak türler `packages/api-client/src/resources/*`
/// ile aynıdır; her model kaynağındaki DTO'ya işaret eder (R-99: OpenAPI şemaları boş).
typedef Json = Map<String, dynamic>;

DateTime _date(Object? value) => DateTime.parse(value! as String);
DateTime? _dateOrNull(Object? value) => value == null ? null : _date(value);
List<Json> _list(Object? value) => (value! as List).cast<Json>();

/// Kaynak: catalog.service.ts (ServiceCategory).
class ServiceCategory {
  const ServiceCategory({
    required this.id,
    required this.slug,
    required this.name,
  });
  factory ServiceCategory.fromJson(Json json) => ServiceCategory(
    id: json['id'] as String,
    slug: json['slug'] as String,
    name: json['name'] as String,
  );
  final String id;
  final String slug;
  final String name;
}

/// Kaynak: catalog.service.ts (ServiceDefinition).
class ServiceDefinition {
  const ServiceDefinition({
    required this.id,
    required this.name,
    required this.categorySlug,
    this.defaultDurationMinutes,
  });
  factory ServiceDefinition.fromJson(Json json) => ServiceDefinition(
    id: json['id'] as String,
    name: json['name'] as String,
    categorySlug: json['categorySlug'] as String,
    defaultDurationMinutes: json['defaultDurationMinutes'] as int?,
  );
  final String id;
  final String name;
  final String categorySlug;
  final int? defaultDurationMinutes;
}

/// Kaynak: addresses/dto (AddressResponseDto).
class Address {
  const Address({
    required this.id,
    required this.city,
    required this.district,
    required this.line,
    required this.latitude,
    required this.longitude,
    this.label,
  });
  factory Address.fromJson(Json json) => Address(
    id: json['id'] as String,
    label: json['label'] as String?,
    city: json['city'] as String,
    district: json['district'] as String,
    line: json['line'] as String,
    latitude: (json['latitude'] as num).toDouble(),
    longitude: (json['longitude'] as num).toDouble(),
  );
  final String id;
  final String? label;
  final String city;
  final String district;
  final String line;
  final double latitude;
  final double longitude;

  String get display => label != null && label!.isNotEmpty
      ? '$label — $district, $city'
      : '$line, $district/$city';
}

/// Kaynak: booking-request.dto.ts (BookingRequestResponseDto).
class BookingRequest {
  const BookingRequest({
    required this.id,
    required this.serviceId,
    required this.addressId,
    required this.preferredStart,
    required this.preferredEnd,
    required this.durationMinutes,
    this.parserVersion,
    this.parserConfidence,
  });
  factory BookingRequest.fromJson(Json json) => BookingRequest(
    id: json['id'] as String,
    serviceId: json['serviceId'] as String,
    addressId: json['addressId'] as String,
    preferredStart: _date(json['preferredStart']),
    preferredEnd: _date(json['preferredEnd']),
    durationMinutes: json['durationMinutes'] as int,
    parserVersion: json['parserVersion'] as String?,
    parserConfidence: (json['parserConfidence'] as num?)?.toDouble(),
  );
  final String id;
  final String serviceId;
  final String addressId;
  final DateTime preferredStart;
  final DateTime preferredEnd;
  final int durationMinutes;

  /// Ar-Ge izlenebilirliği (ADR-0012 §1); form yolunda `null`.
  final String? parserVersion;
  final double? parserConfidence;
}

class Clarification {
  const Clarification({
    required this.field,
    required this.question,
    required this.options,
  });
  factory Clarification.fromJson(Json json) => Clarification(
    field: json['field'] as String,
    question: json['question'] as String,
    options: (json['options'] as List).cast<String>(),
  );
  final String field;
  final String question;
  final List<String> options;
}

enum FromTextStatus { created, needsClarification, formRequired }

/// Kaynak: CreateFromTextResponseDto. `FORM_REQUIRED`: AI erişilemiyor — form açılır (T-15).
class FromTextResult {
  const FromTextResult({
    required this.status,
    required this.clarifications,
    this.request,
  });
  factory FromTextResult.fromJson(Json json) => FromTextResult(
    status: switch (json['status']) {
      'CREATED' => FromTextStatus.created,
      'NEEDS_CLARIFICATION' => FromTextStatus.needsClarification,
      'FORM_REQUIRED' => FromTextStatus.formRequired,
      final other => throw FormatException('Bilinmeyen durum: $other'),
    },
    request: json['request'] == null
        ? null
        : BookingRequest.fromJson(json['request'] as Json),
    clarifications: _list(
      json['clarifications'],
    ).map(Clarification.fromJson).toList(),
  );
  final FromTextStatus status;
  final BookingRequest? request;
  final List<Clarification> clarifications;
}

/// Kaynak: matching.dto.ts (MatchResultResponseDto). Yalnız **seçilen** sağlayıcı döner;
/// eşleşme başarılıysa rezervasyon backend'de oluşmuştur (`bookingId`).
class MatchResult {
  const MatchResult({
    required this.matched,
    required this.degraded,
    required this.explanation,
    this.bookingId,
    this.providerId,
    this.providerName,
    this.scheduledStart,
    this.scheduledEnd,
  });
  factory MatchResult.fromJson(Json json) => MatchResult(
    matched: json['status'] == 'MATCHED',
    degraded: json['degraded'] as bool,
    bookingId: json['bookingId'] as String?,
    providerId: json['providerId'] as String?,
    providerName: json['providerName'] as String?,
    scheduledStart: _dateOrNull(json['scheduledStart']),
    scheduledEnd: _dateOrNull(json['scheduledEnd']),
    explanation: _list(json['explanation'])
        .map((e) => (code: e['code'] as String, value: e['value'] as num?))
        .toList(),
  );
  final bool matched;
  final bool degraded;
  final String? bookingId;
  final String? providerId;
  final String? providerName;
  final DateTime? scheduledStart;
  final DateTime? scheduledEnd;
  final List<({String code, num? value})> explanation;
}

/// Kaynak: booking.dto.ts (BookingResponseDto). `priceMinor` BIGINT → **string**.
class Booking {
  const Booking({
    required this.id,
    required this.customerId,
    required this.serviceId,
    required this.scheduledStart,
    required this.scheduledEnd,
    required this.priceMinor,
    required this.currency,
    required this.status,
    this.providerId,
  });
  factory Booking.fromJson(Json json) => Booking(
    id: json['id'] as String,
    customerId: json['customerId'] as String,
    providerId: json['providerId'] as String?,
    serviceId: json['serviceId'] as String,
    scheduledStart: _date(json['scheduledStart']),
    scheduledEnd: _date(json['scheduledEnd']),
    priceMinor: json['priceMinor'] as String,
    currency: json['currency'] as String,
    status: json['status'] as String,
  );
  final String id;
  final String customerId;
  final String? providerId;
  final String serviceId;
  final DateTime scheduledStart;
  final DateTime scheduledEnd;
  final String priceMinor;
  final String currency;
  final String status;
}

class BookingHistoryEntry {
  const BookingHistoryEntry({required this.toStatus, required this.createdAt});
  factory BookingHistoryEntry.fromJson(Json json) => BookingHistoryEntry(
    toStatus: json['toStatus'] as String,
    createdAt: _date(json['createdAt']),
  );
  final String toStatus;
  final DateTime createdAt;
}

/// Kaynak: payment.dto.ts (PaymentResponseDto).
class Payment {
  const Payment({
    required this.amountMinor,
    required this.currency,
    required this.refundedMinor,
    required this.status,
  });
  factory Payment.fromJson(Json json) => Payment(
    amountMinor: json['amountMinor'] as String,
    currency: json['currency'] as String,
    refundedMinor: json['refundedMinor'] as String,
    status: json['status'] as String,
  );
  final String amountMinor;
  final String currency;
  final String refundedMinor;
  final String status;
}

/// Kaynak: disputes/dto (DisputeResponseDto) — açan taraf bilgisi yoktur.
class Dispute {
  const Dispute({
    required this.id,
    required this.reason,
    required this.status,
    required this.createdAt,
    this.description,
    this.resolution,
  });
  factory Dispute.fromJson(Json json) => Dispute(
    id: json['id'] as String,
    reason: json['reason'] as String,
    description: json['description'] as String?,
    status: json['status'] as String,
    resolution: json['resolution'] as String?,
    createdAt: _date(json['createdAt']),
  );
  final String id;
  final String reason;
  final String? description;
  final String status;
  final String? resolution;
  final DateTime createdAt;

  bool get isOpen => status == 'OPEN' || status == 'UNDER_REVIEW';
}

/// Kaynak: safety.dto.ts (SafetySessionParticipantDto). Bilinçli olarak **dar**dır
/// (ADR-0019 §9): risk seviyesi, kurallar, koordinat yok; karşı tarafın paniği gösterilmez.
class SafetySession {
  const SafetySession({
    required this.sessionId,
    required this.status,
    required this.telemetryExpectedFromYou,
    required this.telemetryIntervalSeconds,
    required this.lastSequence,
    required this.emergencyActive,
    this.panicRaisedAt,
  });
  factory SafetySession.fromJson(Json json) => SafetySession(
    sessionId: json['sessionId'] as String,
    status: json['status'] as String,
    telemetryExpectedFromYou: json['telemetryExpectedFromYou'] as bool,
    telemetryIntervalSeconds: json['telemetryIntervalSeconds'] as int,
    lastSequence: json['lastSequence'] as int,
    emergencyActive: json['emergencyActive'] as bool,
    panicRaisedAt: _dateOrNull(json['panicRaisedAt']),
  );
  final String sessionId;
  final String status;
  final bool telemetryExpectedFromYou;
  final int telemetryIntervalSeconds;
  final int lastSequence;
  final bool emergencyActive;
  final DateTime? panicRaisedAt;

  bool get isClosed => status == 'CLOSED';

  /// Backend paniği yalnız varış ve aktif hizmette kabul eder (panic.service.ts
  /// `assertAccepting`); PRE_SERVICE'te buton yerine 112 yolu gösterilir.
  bool get acceptsPanic => status == 'ARRIVAL_MONITORING' || status == 'ACTIVE';
}

/// Yok ise `null` döndüren okuma (`PROFILE_NOT_FOUND` gibi "durum" kodları).
Future<T?> _orNullOn<T>(String code, Future<T> future) async {
  try {
    return await future;
  } on ApiError catch (error) {
    if (error.code == code) return null;
    rethrow;
  }
}

class CustomerApi {
  const CustomerApi(this._client);
  final ApiClient _client;

  static String _seg(String value) => ApiClient.segment(value);

  // --- Katalog & adres ---
  Future<List<ServiceCategory>> categories() async => _list(
    await _client.get('/service-categories'),
  ).map(ServiceCategory.fromJson).toList();

  Future<List<ServiceDefinition>> services() async => _list(
    await _client.get('/services'),
  ).map(ServiceDefinition.fromJson).toList();

  Future<List<Address>> addresses() async =>
      _list(await _client.get('/addresses')).map(Address.fromJson).toList();

  /// Kaynak: CreateAddressDto — city/district 2..100, line 5..500, label ≤60.
  Future<Address> createAddress({
    required String city,
    required String district,
    required String line,
    required double latitude,
    required double longitude,
    String? label,
  }) async => Address.fromJson(
    await _client.post(
          '/addresses',
          body: {
            if (label != null && label.isNotEmpty) 'label': label,
            'city': city,
            'district': district,
            'line': line,
            'latitude': latitude,
            'longitude': longitude,
          },
        )
        as Json,
  );

  // --- Talep & eşleşme ---
  Future<FromTextResult> requestFromText(
    String rawText,
    String addressId,
  ) async => FromTextResult.fromJson(
    await _client.post(
          '/booking-requests/from-text',
          body: {'rawText': rawText, 'addressId': addressId},
        )
        as Json,
  );

  /// Kaynak: CreateRequestFromFormDto — durationMinutes 30..1440.
  Future<BookingRequest> requestFromForm({
    required String serviceId,
    required String addressId,
    required DateTime preferredStart,
    required DateTime preferredEnd,
    required int durationMinutes,
  }) async => BookingRequest.fromJson(
    await _client.post(
          '/booking-requests',
          body: {
            'serviceId': serviceId,
            'addressId': addressId,
            'preferredStart': preferredStart.toUtc().toIso8601String(),
            'preferredEnd': preferredEnd.toUtc().toIso8601String(),
            'durationMinutes': durationMinutes,
          },
        )
        as Json,
  );

  Future<BookingRequest> request(String id) async => BookingRequest.fromJson(
    await _client.get('/booking-requests/${_seg(id)}') as Json,
  );

  Future<MatchResult> match(String requestId, String idempotencyKey) async =>
      MatchResult.fromJson(
        await _client.post(
              '/booking-requests/${_seg(requestId)}/match',
              idempotencyKey: idempotencyKey,
            )
            as Json,
      );

  Future<MatchResult> matchResult(String requestId) async =>
      MatchResult.fromJson(
        await _client.get('/booking-requests/${_seg(requestId)}/match') as Json,
      );

  // --- Randevu ---
  Future<List<Booking>> bookings() async =>
      _list(await _client.get('/bookings')).map(Booking.fromJson).toList();

  Future<Booking> booking(String id) async =>
      Booking.fromJson(await _client.get('/bookings/${_seg(id)}') as Json);

  Future<List<BookingHistoryEntry>> history(String id) async => _list(
    await _client.get('/bookings/${_seg(id)}/history'),
  ).map(BookingHistoryEntry.fromJson).toList();

  /// Ödeme henüz başlatılmadıysa backend `404 NOT_FOUND` → `null`.
  Future<Payment?> payment(String bookingId) => _orNullOn(
    'NOT_FOUND',
    _client
        .get('/bookings/${_seg(bookingId)}/payment')
        .then((v) => Payment.fromJson(v! as Json)),
  );

  /// Gövde boştur: tutar sunucuda rezervasyondan okunur.
  Future<void> authorizePayment(String bookingId, String idempotencyKey) =>
      _client.post(
        '/bookings/${_seg(bookingId)}/payment',
        idempotencyKey: idempotencyKey,
      );

  Future<Booking> cancel(
    String bookingId,
    String? reason,
    String idempotencyKey,
  ) async => Booking.fromJson(
    await _client.post(
          '/bookings/${_seg(bookingId)}/cancel',
          body: {if (reason != null && reason.isNotEmpty) 'reason': reason},
          idempotencyKey: idempotencyKey,
        )
        as Json,
  );

  /// Müşteri hizmeti onaylar: `CHECKED_OUT → CUSTOMER_CONFIRMED`.
  Future<Booking> confirmService(
    String bookingId,
    String idempotencyKey,
  ) async => Booking.fromJson(
    await _client.post(
          '/bookings/${_seg(bookingId)}/transitions',
          body: {'to': 'CUSTOMER_CONFIRMED'},
          idempotencyKey: idempotencyKey,
        )
        as Json,
  );

  /// Kaynak: CreateReviewDto — rating 1..5, comment ≤2000.
  Future<void> createReview(
    String bookingId,
    Json body,
    String idempotencyKey,
  ) => _client.post(
    '/bookings/${_seg(bookingId)}/review',
    body: body,
    idempotencyKey: idempotencyKey,
  );

  Future<List<Dispute>> disputes(String bookingId) async => _list(
    await _client.get('/bookings/${_seg(bookingId)}/disputes'),
  ).map(Dispute.fromJson).toList();

  /// Kaynak: OpenDisputeDto — description ≤2000.
  Future<void> openDispute(
    String bookingId,
    Json body,
    String idempotencyKey,
  ) => _client.post(
    '/bookings/${_seg(bookingId)}/disputes',
    body: body,
    idempotencyKey: idempotencyKey,
  );

  // --- Güvenlik ---
  /// Oturum henüz açılmadıysa `SAFETY_SESSION_NOT_FOUND` → `null` (durumdur, hata değil).
  Future<SafetySession?> safetySession(String bookingId) => _orNullOn(
    'SAFETY_SESSION_NOT_FOUND',
    _client
        .get('/bookings/${_seg(bookingId)}/safety-session')
        .then((v) => SafetySession.fromJson(v! as Json)),
  );

  /// Panik — backend oran sınırı uygulamaz ve tekrarı kendisi tekilleştirir; `Idempotency-Key`
  /// **gönderilmez** ki Redis kesintisi paniği bloklamasın (ADR-0008 §3).
  Future<void> panic(String sessionId, {String? category}) => _client.post(
    '/safety/sessions/${_seg(sessionId)}/panic',
    body: {'category': ?category},
  );
}
