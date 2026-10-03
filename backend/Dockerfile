# --- Stage 1: Build the application ---
FROM maven:3.9-eclipse-temurin-21-alpine AS builder

WORKDIR /app

# Copy pom.xml first to cache dependencies
COPY pom.xml ./
RUN mvn dependency:go-offline -B || true

# Copy source code and build the executable JAR
COPY src ./src
RUN mvn clean package -DskipTests

# --- Stage 2: Minimal runtime environment ---
FROM eclipse-temurin:21-jre-alpine

WORKDIR /app

# Create a non-root user for security
RUN addgroup -S spring && adduser -S spring -G spring
USER spring:spring

# Copy built JAR from builder stage
COPY --from=builder /app/target/*.jar app.jar

# Expose Spring Boot default port
EXPOSE 8080

# Run the application
ENTRYPOINT ["java", "-jar", "app.jar"]

