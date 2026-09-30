import 'dart:async';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;

import 'api_client.dart';
import 'api_error.dart';
import 'customer_api.dart' show Booking, Json;

List<Json> _list(Object? value) => (value! as List).cast<Json>();
DateTime _date(Object? value) => DateTime.parse(value! as String);

/// Kaynak: ProviderSkillResponseDto. `verified` yalnız operatör verir; eşleştirme
/// doğrulanmamış yetkinliği saymaz (Faz 7 hard constraint).
class ProviderSkill {
  const ProviderSkill({
    required this.skillId,
    required this.name,
    required this.level,
    required this.verified,
  });
  factory ProviderSkill.fromJson(Json json) => ProviderSkill(
    skillId: json['skillId'] as String,
    name: json['name'] as String,
    level: json['level'] as String,
    verified: json['verified'] as bool,
  );
  final String skillId;
  final String name;
  final String level;
  final bool verified;
}

const skillLevelLabels = {
  'BEGINNER': 'Başlangıç',
  'INTERMEDIATE': 'Orta',
  'EXPERT': 'Uzman',
};

/// Kaynak: catalog.service.ts (Skill).
class SkillDefinition {
  const SkillDefinition({required this.id, required this.name});
  factory SkillDefinition.fromJson(Json json) =>
      SkillDefinition(id: json['id'] as String, name: json['name'] as String);
  final String id;
  final String name;
}

/// Kaynak: ProviderServiceResponseDto — aday havuzu buradan başlar.
class ProviderService {
  const ProviderService({required this.serviceId, required this.active});
  factory ProviderService.fromJson(Json json) => ProviderService(
    serviceId: json['serviceId'] as String,
    active: json['active'] as bool,
  );
  final String serviceId;
  final bool active;
}

/// Kaynak: ProviderServiceAreaResponseDto — merkez + yarıçap; serbest poligon yok.
class ServiceArea {
  const ServiceArea({
    required this.id,
    required this.name,
    required this.radiusMeters,
    required this.active,
  });
  factory ServiceArea.fromJson(Json json) => ServiceArea(
    id: json['id'] as String,
    name: json['name'] as String,
    radiusMeters: json['radiusMeters'] as int,
    active: json['active'] as bool,
  );
  final String id;
  final String name;
  final int radiusMeters;
  final bool active;
}

/// Kaynak: availability.dto.ts (AvailabilityResponseDto).
class AvailabilityWindow {
  const AvailabilityWindow({
    required this.id,
    required this.startsAt,
    required this.endsAt,
  });
  factory AvailabilityWindow.fromJson(Json json) => AvailabilityWindow(
    id: json['id'] as String,
    startsAt: _date(json['startsAt']),
    endsAt: _date(json['endsAt']),
  );
  final String id;
  final DateTime startsAt;
  final DateTime endsAt;
}

/// Kaynak: documents/dto (DocumentResponseDto). `sha256` storage'daki nesneden okunur.
class EvidenceDocument {
  const EvidenceDocument({
    required this.id,
    required this.documentType,
    required this.status,
    required this.createdAt,
    this.sha256,
  });
  factory EvidenceDocument.fromJson(Json json) => EvidenceDocument(
    id: json['id'] as String,
    documentType: json['documentType'] as String,
    status: json['status'] as String,
    sha256: json['sha256'] as String?,
    createdAt: _date(json['createdAt']),
  );
  final String id;
  final String documentType;
  final String status;
  final String? sha256;
  final DateTime createdAt;

  bool get uploaded => status == 'AVAILABLE';
}

/// Kaynak: documents.service.ts (ALLOWED_CONTENT_TYPES) — backend ayrıca doğrular.
const evidenceContentTypes = {
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
};

/// Varsayılan `STORAGE_MAX_UPLOAD_BYTES` (10 MiB). Ön kontroldür; sınırı backend uygular.
const evidenceMaxBytes = 10 * 1024 * 1024;

String sha256Hex(Uint8List bytes) => sha256.convert(bytes).toString();

/// Sağlayıcının kendi profili (`/providers/me*`) — yalnız oturumdaki kullanıcının kaydına yazar
/// (yol parametresi sahibi belirtmez; IDOR yüzeyi yok).
class ProviderApi {
  ProviderApi(this._client, {http.Client? uploadClient})
    : _upload = uploadClient ?? http.Client();

  final ApiClient _client;
  final http.Client _upload;
  static const _me = '/providers/me';
  static String _seg(String value) => ApiClient.segment(value);

  /// Kaynak: UpdateProviderProfileDto — displayName 2..120, bio ≤2000, experienceYears 0..80,
  /// maxDailyBookings 1..10.
  Future<void> updateProfile(Json body) => _client.patch(_me, body: body);

  /// `DRAFT`/`REJECTED` → `PENDING_REVIEW`. Onay/ret operatöre aittir.
  Future<void> submit() => _client.post('$_me/submit');

  Future<bool> identityVerified() async =>
      ((await _client.get('/verification/status'))! as Json)['identityVerified']
          as bool;

  Future<List<SkillDefinition>> skillCatalog() async => _list(
    await _client.get('/skills'),
  ).map(SkillDefinition.fromJson).toList();

  Future<List<ProviderSkill>> skills() async => _list(
    await _client.get('$_me/skills'),
  ).map(ProviderSkill.fromJson).toList();

  Future<void> addSkill(String skillId, String level) =>
      _client.post('$_me/skills', body: {'skillId': skillId, 'level': level});

  Future<void> removeSkill(String skillId) =>
      _client.delete('$_me/skills/${_seg(skillId)}');

  Future<List<ProviderService>> services() async => _list(
    await _client.get('$_me/services'),
  ).map(ProviderService.fromJson).toList();

  Future<void> addService(String serviceId) =>
      _client.post('$_me/services', body: {'serviceId': serviceId});

  Future<void> removeService(String serviceId) =>
      _client.delete('$_me/services/${_seg(serviceId)}');

  Future<List<ServiceArea>> areas() async => _list(
    await _client.get('$_me/service-areas'),
  ).map(ServiceArea.fromJson).toList();

  /// Kaynak: AddServiceAreaDto — name 2..80, koordinat ≤6 ondalık, yarıçap 500..100000 m.
  Future<void> addArea({
    required String name,
    required double latitude,
    required double longitude,
    required int radiusMeters,
  }) => _client.post(
    '$_me/service-areas',
    body: {
      'name': name,
      'latitude': double.parse(latitude.toStringAsFixed(6)),
      'longitude': double.parse(longitude.toStringAsFixed(6)),
      'radiusMeters': radiusMeters,
    },
  );

  Future<void> removeArea(String areaId) =>
      _client.delete('$_me/service-areas/${_seg(areaId)}');

  /// `from`/`to` zorunlu (backend aralıksız listeyi kabul etmez).
  Future<List<AvailabilityWindow>> availability(
    DateTime from,
    DateTime to,
  ) async => _list(
    await _client.get(
      '$_me/availability',
      query: {
        'from': from.toUtc().toIso8601String(),
        'to': to.toUtc().toIso8601String(),
      },
    ),
  ).map(AvailabilityWindow.fromJson).toList();

  Future<void> addAvailability(DateTime startsAt, DateTime endsAt) =>
      _client.post(
        '$_me/availability',
        body: {
          'startsAt': startsAt.toUtc().toIso8601String(),
          'endsAt': endsAt.toUtc().toIso8601String(),
        },
      );

  Future<void> removeAvailability(String id) =>
      _client.delete('$_me/availability/${_seg(id)}');

  // --- Randevu komutları ---
  /// Sağlayıcı onayı: `PROVIDER_PENDING → CONFIRMED`. Ret, gerekçeli `cancel`'dır.
  Future<Booking> confirm(String bookingId, String idempotencyKey) async =>
      Booking.fromJson(
        (await _client.post(
              '/bookings/${_seg(bookingId)}/confirm',
              idempotencyKey: idempotencyKey,
            ))!
            as Json,
      );

  Future<Booking> transition(
    String bookingId,
    String to,
    String idempotencyKey,
  ) async => Booking.fromJson(
    (await _client.post(
          '/bookings/${_seg(bookingId)}/transitions',
          body: {'to': to},
          idempotencyKey: idempotencyKey,
        ))!
        as Json,
  );

  // --- Kanıt ---
  Future<List<EvidenceDocument>> documents(String bookingId) async => _list(
    await _client.get('/bookings/${_seg(bookingId)}/documents'),
  ).map(EvidenceDocument.fromJson).toList();

  /// Kayıt → imzalı URL'e **doğrudan** PUT → SHA-256 ile onay. Kayıt başarılı olup yükleme ağda
  /// kalırsa [resume] ile aynı kayıttan devam edilir (yeni kayıt açılmaz — web ile aynı).
  Future<EvidenceDocument> uploadEvidence({
    required String bookingId,
    required String documentType,
    required String contentType,
    required Uint8List bytes,
    PendingUpload? resume,
    void Function(PendingUpload pending)? onRegistered,
  }) async {
    if (!evidenceContentTypes.contains(contentType)) {
      throw const ApiError(
        status: 0,
        code: 'UNSUPPORTED_CONTENT_TYPE',
        message: 'Bu dosya türü desteklenmiyor (JPEG, PNG, WebP ya da PDF).',
      );
    }
    if (bytes.length > evidenceMaxBytes) {
      throw const ApiError(
        status: 0,
        code: 'FILE_TOO_LARGE',
        message: 'Dosya 10 MB’tan büyük olamaz.',
      );
    }
    var pending = resume;
    if (pending == null) {
      final registration =
          (await _client.post(
                '/documents',
                body: {
                  'bookingId': bookingId,
                  'documentType': documentType,
                  'contentType': contentType,
                },
              ))!
              as Json;
      pending = PendingUpload(
        documentId: (registration['document'] as Json)['id'] as String,
        uploadUrl: registration['uploadUrl'] as String,
      );
      onRegistered?.call(pending);
    }
    await _put(pending.uploadUrl, bytes, contentType);
    return EvidenceDocument.fromJson(
      (await _client.post(
            '/documents/${_seg(pending.documentId)}/confirm',
            body: {'sha256': sha256Hex(bytes)},
          ))!
          as Json,
    );
  }

  /// İmzalı URL Emek API'sine gitmez: kimlik/App Check başlığı **taşımaz** (imza yetkidir),
  /// yalnız imzada sabitlenen `Content-Type`. Yerel mock storage göreli yol döner
  /// (`/api/v1/_dev/storage/...`) — API köküne göre çözülür.
  Future<void> _put(
    String uploadUrl,
    Uint8List bytes,
    String contentType,
  ) async {
    final target = _client.baseUrl.resolve(uploadUrl);
    final http.Response response;
    try {
      response = await _upload
          .put(target, headers: {'Content-Type': contentType}, body: bytes)
          .timeout(const Duration(seconds: 60));
    } on TimeoutException {
      throw ApiError.network();
    } on http.ClientException {
      throw ApiError.network();
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw ApiError(
        status: response.statusCode,
        code: 'UPLOAD_FAILED',
        message: 'Dosya yüklenemedi. Lütfen tekrar deneyin.',
      );
    }
  }
}

/// Kaydı açılmış ama henüz onaylanmamış yükleme (yalnız bellekte; imzalı URL loglanmaz).
class PendingUpload {
  const PendingUpload({required this.documentId, required this.uploadUrl});
  final String documentId;
  final String uploadUrl;
}
