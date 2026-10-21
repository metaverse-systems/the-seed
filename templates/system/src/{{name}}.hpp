#pragma once

#include <libecs-cpp/ecs.hpp>

class {{identifier}} : public ecs::System
{
  public:
    {{identifier}}();
    {{identifier}}(nlohmann::json);
    nlohmann::json Export() const;
    void Update();
    void Initialize();
    void Shutdown();
};
