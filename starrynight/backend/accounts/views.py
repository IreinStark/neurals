from .serializers import (
    RegisterSerializer,
    ChangePasswordSerializer,
    UpdateUserSerializer,
    CustomJWTSerializer
)
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework import generics
from django.contrib.auth.models import User
from django.contrib.auth.tokens import default_token_generator
from django.utils.http import urlsafe_base64_encode, urlsafe_base64_decode
from django.utils.encoding import force_bytes, force_str
from rest_framework.views import APIView
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework.response import Response
from rest_framework import status
from rest_framework_simplejwt.token_blacklist.models import (
    BlacklistedToken,
    OutstandingToken,
)
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer
from rest_framework_simplejwt.views import TokenRefreshView, TokenObtainPairView


class LoginView(TokenObtainPairView):
    queryset = User.objects.all()
    permission_classes = (AllowAny,)
    serializer_class = CustomJWTSerializer


class RegisterView(generics.CreateAPIView):
    queryset = User.objects.all()
    permission_classes = (AllowAny,)
    serializer_class = RegisterSerializer


class ChangePasswordView(generics.UpdateAPIView):
    queryset = User.objects.all()
    permission_classes = (IsAuthenticated,)
    serializer_class = ChangePasswordSerializer


class UpdateProfileView(generics.UpdateAPIView):
    queryset = User.objects.all()
    permission_classes = (IsAuthenticated,)
    serializer_class = UpdateUserSerializer


class LogoutView(APIView):
    permission_classes = (IsAuthenticated,)

    def post(self, request):
        try:
            refresh_token = request.data["refresh_token"]
            token = RefreshToken(refresh_token)
            token.blacklist()

            return Response(status=status.HTTP_205_RESET_CONTENT)
        except Exception as e:
            return Response(status=status.HTTP_400_BAD_REQUEST)


class LogoutAllView(APIView):
    permission_classes = (IsAuthenticated,)

    def post(self, request):
        tokens = OutstandingToken.objects.filter(user_id=request.user.id)
        for token in tokens:
            t, _ = BlacklistedToken.objects.get_or_create(token=token)

        return Response(status=status.HTTP_205_RESET_CONTENT)


@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
def forgot_password_view(request):
    email = request.data.get("email", "").strip().lower()
    if not email:
        return Response({"error": "Email is required."}, status=400)

    try:
        user = User.objects.get(email__iexact=email)
    except User.DoesNotExist:
        # Don't reveal whether the email exists
        return Response({"message": "If that email is registered you will receive a reset link."})

    token = default_token_generator.make_token(user)
    uid = urlsafe_base64_encode(force_bytes(user.pk))

    return Response({
        "message": "Reset link generated.",
        "uid": uid,
        "token": token,
    })


@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
def reset_password_view(request):
    uid = request.data.get("uid", "")
    token = request.data.get("token", "")
    new_password = request.data.get("password", "")

    if not uid or not token or not new_password:
        return Response({"error": "Missing required fields."}, status=400)

    if len(new_password) < 6:
        return Response({"error": "Password must be at least 6 characters."}, status=400)

    try:
        user_pk = force_str(urlsafe_base64_decode(uid))
        user = User.objects.get(pk=user_pk)
    except (TypeError, ValueError, OverflowError, User.DoesNotExist):
        return Response({"error": "Invalid reset link."}, status=400)

    if not default_token_generator.check_token(user, token):
        return Response({"error": "This reset link has expired or already been used."}, status=400)

    user.set_password(new_password)
    user.save()
    return Response({"message": "Password updated. You can now log in."})
