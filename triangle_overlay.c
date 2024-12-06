#include <stdbool.h>
#define CNFG_IMPLEMENTATION
#define CNFGOGL
#include "rawdraw_sf.h"
#include "openvr_capi.h"

// OpenVR function declarations
intptr_t VR_InitInternal(EVRInitError *peError, EVRApplicationType eType);
void VR_ShutdownInternal();
intptr_t VR_GetGenericInterface(const char *pchInterfaceVersion, EVRInitError *peError);

// Minimum required rawdraw callbacks
void HandleKey(int keycode, int bDown) { }
void HandleButton(int x, int y, int button, int bDown) { }
void HandleMotion(int x, int y, int mask) { }
void HandleDestroy() { }

// Helper function to get OpenVR interfaces
void* CNOVRGetOpenVRFunctionTable(const char* interfacename) {
    EVRInitError e;
    char fnTableName[128];
    snprintf(fnTableName, 128, "FnTable:%s", interfacename);
    void* ret = (void*)VR_GetGenericInterface(fnTableName, &e);
    printf("Getting Interface: %s = %p (%d)\n", fnTableName, ret, e);
    if (!ret) {
        exit(1);
    }
    return ret;
}

#define WIDTH 256
#define HEIGHT 256

int main() {
    // Create hidden window for OpenGL context
    CNFGSetup("Triangle Overlay", -WIDTH, -HEIGHT);

    // Initialize OpenVR
    EVRInitError ierr;
    uint32_t token = VR_InitInternal(&ierr, EVRApplicationType_VRApplication_Overlay);
    if (!token) {
        printf("Failed to initialize OpenVR\n");
        return -1;
    }

    // Get OpenVR interfaces
    struct VR_IVROverlay_FnTable* overlay = CNOVRGetOpenVRFunctionTable(IVROverlay_Version);

    // Create overlay
    VROverlayHandle_t overlayHandle;
    overlay->CreateOverlay("triangle.overlay", "Triangle", &overlayHandle);
    overlay->SetOverlayWidthInMeters(overlayHandle, 0.3);
    overlay->ShowOverlay(overlayHandle);

    // Create and setup texture
    GLuint texture;
    glGenTextures(1, &texture);
    glBindTexture(GL_TEXTURE_2D, texture);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, WIDTH, HEIGHT, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);

    // Main render loop
    while (true) {
        // Clear frame
        CNFGBGColor = 0x00000000;
        CNFGClearFrame();

        // Draw triangle
        CNFGColor(0xFF0000FF);  // Red
        CNFGTackPixel(WIDTH/2, HEIGHT/4);
        CNFGTackPixel(WIDTH/4, 3*HEIGHT/4);
        CNFGTackPixel(3*WIDTH/4, 3*HEIGHT/4);
        CNFGDrawLine(WIDTH/2, HEIGHT/4, WIDTH/4, 3*HEIGHT/4);
        CNFGDrawLine(WIDTH/4, 3*HEIGHT/4, 3*WIDTH/4, 3*HEIGHT/4);
        CNFGDrawLine(3*WIDTH/4, 3*HEIGHT/4, WIDTH/2, HEIGHT/4);

        // Update texture
        glBindTexture(GL_TEXTURE_2D, texture);
        glCopyTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, 0, 0, WIDTH, HEIGHT, 0);

        // Submit to OpenVR
        struct Texture_t tex = {
            .handle = (void*)(intptr_t)texture,
            .eType = ETextureType_TextureType_OpenGL,
            .eColorSpace = EColorSpace_ColorSpace_Auto
        };
        overlay->SetOverlayTexture(overlayHandle, &tex);

        // Process events
        VREvent_t event;
        while (overlay->PollNextOverlayEvent(overlayHandle, &event, sizeof(event)));

        // Wait for next frame
        overlay->WaitFrameSync(100);
    }

    return 0;
}