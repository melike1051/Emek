import '../api/api_client.dart';
import '../api/api_error.dart';

/// Kaynak: services/api/src/providers/providers.service.ts (PROVIDER_STATES).
enum ProviderState { draft, pendingReview, approved, rejected, suspended }

ProviderState _providerState(String value) => switch (value) {
  'DRAFT' => ProviderState.draft,
  'PENDING_REVIEW' => ProviderState.pendingReview,
  'APPROVED' => ProviderState.approved,
  'REJECTED' => ProviderState.rejected,
  'SUSPENDED' => ProviderState.suspended,
  _ => throw FormatException('Bilinmeyen sağlayıcı durumu: $value'),
};

/// Kaynak: services/api/src/customers/dto (CustomerProfileResponseDto).
class CustomerProfile {
  const CustomerProfile({required this.userId, required this.displayName});

  factory CustomerProfile.fromJson(Map<String, dynamic> json) =>
      CustomerProfile(
        userId: json['userId'] as String,
        displayName: json['displayName'] as String,
      );

  final String userId;
  final String displayName;
}

/// Kaynak: services/api/src/providers/dto/provider.dto.ts (ProviderProfileResponseDto).
class ProviderProfile {
  const ProviderProfile({
    required this.userId,
    required this.displayName,
    required this.state,
    this.bio,
    this.experienceYears,
    required this.maxDailyBookings,
  });

  factory ProviderProfile.fromJson(Map<String, dynamic> json) =>
      ProviderProfile(
        userId: json['userId'] as String,
        displayName: json['displayName'] as String,
        bio: json['bio'] as String?,
        experienceYears: (json['experienceYears'] as num?)?.toDouble(),
        maxDailyBookings: json['maxDailyBookings'] as int,
        state: _providerState(json['state'] as String),
      );

  final String userId;
  final String displayName;
  final String? bio;
  final double? experienceYears;
  final int maxDailyBookings;
  final ProviderState state;
}

class Session {
  const Session({
    required this.userId,
    required this.roles,
    required this.customer,
    required this.provider,
  });

  final String userId;
  final List<String> roles;
  final CustomerProfile? customer;
  final ProviderProfile? provider;

  bool get hasProfile => customer != null || provider != null;

  /// Varsayılan çalışma alanı: yalnız sağlayıcı profili varsa panel, aksi hâlde müşteri.
  String get home => customer == null && provider != null ? '/panel' : '/';
}

/// Profil henüz yoksa backend `404 PROFILE_NOT_FOUND` döner; bu bir durumdur, hata değil.
Future<T?> _orNullIfMissing<T>(Future<T> future) async {
  try {
    return await future;
  } on ApiError catch (error) {
    if (error.code == 'PROFILE_NOT_FOUND') return null;
    rethrow;
  }
}

class SessionApi {
  const SessionApi(this._client);

  final ApiClient _client;

  /// `POST /auth/session` ilk girişte Emek kullanıcısını oluşturur (idempotent), ardından
  /// profiller paralel okunur. `/providers/me` PROVIDER rolü ister (rolsüze 403, profil
  /// yokluğu değil) — yalnız rol varsa sorulur.
  Future<Session> bootstrap() async {
    final auth = await _client.post('/auth/session') as Map<String, dynamic>;
    final roles = (auth['roles'] as List).cast<String>();
    final results = await Future.wait<Object?>([
      _orNullIfMissing<Object?>(_client.get('/customers/me')),
      roles.contains('PROVIDER')
          ? _orNullIfMissing<Object?>(_client.get('/providers/me'))
          : Future<Object?>.value(),
    ]);
    return Session(
      userId: auth['userId'] as String,
      roles: roles,
      customer: results[0] == null
          ? null
          : CustomerProfile.fromJson(results[0]! as Map<String, dynamic>),
      provider: results[1] == null
          ? null
          : ProviderProfile.fromJson(results[1]! as Map<String, dynamic>),
    );
  }

  /// Kaynak: CreateCustomerProfileDto — displayName 2..120.
  Future<void> createCustomer(String displayName) =>
      _client.post('/customers/profile', body: {'displayName': displayName});

  /// Kaynak: CreateProviderProfileDto.
  Future<void> createProvider(
    String displayName, {
    String? bio,
    double? experienceYears,
  }) => _client.post(
    '/providers/profile',
    body: {
      'displayName': displayName,
      if (bio != null && bio.isNotEmpty) 'bio': bio,
      'experienceYears': ?experienceYears,
    },
  );
}
