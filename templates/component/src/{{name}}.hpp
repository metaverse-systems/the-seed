#pragma once

#include <libecs-cpp/ecs.hpp>

class {{identifier}} : public ecs::Component
{
  public:
    {{identifier}}();
    {{identifier}}(nlohmann::json);
    nlohmann::json Export() const;
};
